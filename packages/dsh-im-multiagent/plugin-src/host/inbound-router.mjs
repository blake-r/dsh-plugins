// dsh-im-multiagent InboundRouter (plan sections 4, 6.2, 6.7).
//
// Replaces the single-session TelegramHarnessBridge: every normalized update
// from the vendored TelegramRuntime poll loop lands here. The router applies
// the section-4 algorithm and delivers the message to the addressed session
// through the host agents service:
//
//   rule 0  plugin command            -> CommandDispatcher
//   rule 1  reply on an indexed msg   -> that session (picker selection first)
//   rule 2  "/<slug> <text>"          -> session from state.menuSlugs
//   rule 3  pendingTarget (one-shot)  -> that session
//   rule 4  lone session in the chat  -> it
//   else                              -> no-recipient hint (never random)
//
// Delivery modes (section 6.7): steer (default, next-step) or queue
// (followup, next-turn; explicit /enqueue). A cold session is resumed first
// (ctx.agents.resume + preset mount), then steered. Every accepted inbound
// message is written to the MessageIndex so a reply on the user's own message
// continues the same session.

import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const PLUGIN_COMMANDS = Object.freeze(new Set([
  'stop', 'as', 'agents', 'new', 'to', 'cmd', 'skill',
  'follow', 'unfollow', 'hs', 'history', 'steer', 'enqueue',
  'compact', 'alias', 'cancel', 'start', 'help', 'status', 'version',
  'ws', 'workspaces', 'ps', 'presets',
]));

export const PENDING_TARGET_TTL_MS = 5 * 60 * 1_000;
export const PICKER_TTL_MS = 5 * 60 * 1_000;

const SLUG_PATTERN = /^\/([a-z0-9_а-яё-]+)\s+([\s\S]+)$/i;

export class InboundRouter {
  #ctx;
  #config;
  #state;
  #index;
  #mirror;
  #i18n;
  #commands;
  #logger;
  #bot = null;
  #signal = null;
  #accepted = new Set();
  #pendingTargets = new Map(); // chatKey -> { sessionId, expiresAt }
  #pickers = new Map();        // chatKey -> Map<messageId, { kind, sessionId, expiresAt }>
  #delivered = 0;
  #rejected = 0;

  constructor({ ctx, config, state, index, mirror, i18n, commands, logger = console }) {
    if (!ctx || !state || !index || !mirror || !i18n || !commands) {
      throw new TypeError('InboundRouter requires ctx, state, index, mirror, i18n, and commands');
    }
    this.#ctx = ctx;
    this.#config = config ?? {};
    this.#state = state;
    this.#index = index;
    this.#mirror = mirror;
    this.#i18n = i18n;
    this.#commands = commands;
    this.#logger = logger;
  }

  get status() {
    return {
      delivered: this.#delivered,
      rejected: this.#rejected,
      pendingTargets: [...this.#pendingTargets.entries()].map(([chatKey, target]) => ({
        chatKey,
        sessionId: target.sessionId,
        expiresAt: target.expiresAt,
      })),
      pickers: [...this.#pickers.entries()].map(([chatKey, byMessageId]) => ({
        chatKey,
        count: byMessageId.size,
      })),
    };
  }

  /**
   * Bridge factory hook: the runtime hands its TelegramBotClient here before
   * polling starts. Returns this so the factory can be `createBridge: (o) =>
   * router.withBot(o.bot, o)`.
   */
  withBot(bot, { signal } = {}) {
    this.#bot = bot;
    this.#signal = signal;
    return this;
  }

  // --- picker registry (section 4, Q25/Q32; filled by stage 4a) -------------

  /** Register a picker message; a reply on it becomes a picker selection. */
  registerPicker(chatKey, messageId, { kind, sessionId }) {
    const byMessageId = this.#pickers.get(chatKey) ?? new Map();
    byMessageId.set(String(messageId), {
      kind,
      sessionId,
      expiresAt: Date.now() + PICKER_TTL_MS,
    });
    this.#pickers.set(chatKey, byMessageId);
  }

  /** Drop expired pickers; returns the number removed. */
  expirePickers(now = Date.now()) {
    let removed = 0;
    for (const [chatKey, byMessageId] of this.#pickers) {
      for (const [messageId, picker] of byMessageId) {
        if (picker.expiresAt <= now) {
          byMessageId.delete(messageId);
          removed += 1;
        }
      }
      if (byMessageId.size === 0) this.#pickers.delete(chatKey);
    }
    return removed;
  }

  /** Drop every picker and the pending target (the /cancel command). */
  clearPending(chatKey) {
    this.#pendingTargets.delete(chatKey);
    this.#pickers.delete(chatKey);
  }

  /** Set the one-shot pending target (the /to picker, section 4.1). */
  setPendingTarget(chatKey, sessionId) {
    this.#pendingTargets.set(chatKey, {
      sessionId,
      expiresAt: Date.now() + PENDING_TARGET_TTL_MS,
    });
  }

  /**
   * Public delivery entry used by the command dispatcher (/to <name> <text>,
   * /steer, /enqueue). The mode forces the delivery kind: 'steer' (next-step)
   * or 'queue' (next-turn); the default is the configured deliveryMode.
   */
  async deliverToSession(sessionId, text, message, chatKey, { mode } = {}) {
    return this.#deliverToSession(sessionId, text, message, chatKey, mode);
  }

  // --- entry point (called by the runtime poll loop) -------------------------

  async accept(message, { contextSnapshot } = {}) {
    void contextSnapshot;
    if (this.#signal?.aborted) return;
    const chatKey = this.#chatKey(message);
    const messageId = String(message?.messageId ?? '');
    const senderId = String(message?.senderId ?? '');
    if (!messageId || !senderId || !chatKey || message.senderIsBot === true
      || this.#state.hasSeen(messageId) || this.#accepted.has(messageId)) {
      return;
    }
    this.#accepted.add(messageId);
    try {
      if (message.kind === 'callback') {
        await this.#acceptCallback(message, chatKey);
        return;
      }
      // Group chats: only addressed messages are routed (direct reply on the
      // bot or an @mention), mirroring the dsh-im group rule.
      if (message.kind === 'group' && message.addressed !== true) {
        this.#rejected += 1;
        await this.#state.markSeen(messageId);
        return;
      }
      const route = this.#route(message, chatKey);
      await this.#deliver(route, message, chatKey);
      await this.#state.markSeen(messageId);
    } catch (error) {
      this.#logger.error?.('[dsh-im-multiagent] inbound routing failed:', error);
    } finally {
      this.#accepted.delete(messageId);
    }
  }

  /**
   * Inline-keyboard callback (stage 4a): a tap on a picker button. The picker
   * registered under the callback's message id decides the outcome; the query
   * is always answered so Telegram never shows a loading spinner.
   */
  async #acceptCallback(message, chatKey) {
    const messageId = String(message?.messageId ?? '');
    const callbackMessageId = String(message?.callbackMessageId ?? '');
    const picker = callbackMessageId
      ? this.#pickers.get(chatKey)?.get(callbackMessageId)
      : undefined;
    if (picker && picker.expiresAt > Date.now()) {
      await this.#commands.handlePickerSelection(picker, message, chatKey, { router: this });
    } else {
      if (picker) this.#pickers.get(chatKey).delete(callbackMessageId);
      await this.answerCallback(message, {
        text: this.#i18n.t('hint.picker-expired'),
      });
    }
    await this.#state.markSeen(messageId);
  }

  #chatKey(message) {
    const conversationId = String(message?.conversationId ?? '').trim();
    if (!conversationId) return null;
    const kind = message?.kind === 'group' || message?.chatKind === 'group' ? 'group' : 'direct';
    return `${kind}:${conversationId}`;
  }

  // --- routing (section 4) ---------------------------------------------------

  #route(message, chatKey) {
    const text = String(message?.content ?? '').trim();

    // Rule 0: plugin commands.
    if (this.#isPluginCommand(text)) return { kind: 'command', text };

    // Rule 1: reply on an indexed message (picker selection first — Q25/Q32).
    const replyMessageId = message?.replyTo?.messageId;
    if (replyMessageId) {
      const picker = this.#pickers.get(chatKey)?.get(String(replyMessageId));
      if (picker) {
        if (picker.expiresAt > Date.now()) return { kind: 'picker-selection', picker };
        this.#pickers.get(chatKey).delete(String(replyMessageId));
      } else {
        const entry = this.#index.lookup(chatKey, replyMessageId);
        if (entry) return { kind: 'session', sessionId: entry.sessionId };
      }
      // Reply on an unknown / old / foreign message: fall through.
    }

    // Rule 2: "/<session slug> <text>" from the command menu (section 4.2).
    const slug = this.#menuSlug(text);
    if (slug) return { kind: 'session', sessionId: slug.sessionId, text: slug.text };

    // Rule 3: pendingTarget (one-shot, TTL 5 min).
    const pending = this.#pendingTargets.get(chatKey);
    if (pending) {
      this.#pendingTargets.delete(chatKey);
      if (pending.expiresAt > Date.now()) {
        return { kind: 'session', sessionId: pending.sessionId };
      }
    }

    // Rule 4: a lone session is the unambiguous recipient.
    const sessions = Object.keys(this.#mirror.sessions());
    if (sessions.length === 1) return { kind: 'session', sessionId: sessions[0] };

    return { kind: 'no-recipient' };
  }

  #isPluginCommand(text) {
    if (!text.startsWith('/')) return false;
    const name = text.slice(1).split(/\s+/, 1)[0].toLowerCase();
    return PLUGIN_COMMANDS.has(name);
  }

  #menuSlug(text) {
    if (!text.startsWith('/')) return null;
    const match = SLUG_PATTERN.exec(text);
    if (!match) return null;
    const sessionId = this.#state.menuSlugFor(match[1].toLowerCase());
    if (!sessionId) return null;
    return { sessionId, text: match[2].trim() };
  }

  // --- delivery --------------------------------------------------------------

  async #deliver(route, message, chatKey) {
    switch (route.kind) {
      case 'command':
        return this.#commands.handle(message, chatKey, { router: this });
      case 'picker-selection':
        return this.#commands.handlePickerSelection(route.picker, message, chatKey, { router: this });
      case 'session':
        return this.#deliverToSession(route.sessionId, route.text ?? message.content, message, chatKey);
      case 'no-recipient':
        return this.#sendHint(message, 'hint.no-recipient');
      default:
        return undefined;
    }
  }

  async #deliverToSession(sessionId, text, message, chatKey, forcedMode) {
    const content = String(text ?? '').trim();
    if (!content) {
      return this.#sendHint(message, 'hint.text-only');
    }
    const agent = await this.ensureLiveAgent(sessionId);
    if (!agent) {
      return this.#sendHint(message, 'hint.session-gone');
    }
    const userMessage = await this.#inject(agent, content, forcedMode);
    if (!userMessage) return false;
    this.#delivered += 1;
    const telegramMessageId = message?.replyTarget?.replyToMessageId;
    if (telegramMessageId !== undefined) {
      await this.#index.put(chatKey, {
        messageId: telegramMessageId,
        sessionId,
        direction: 'in',
      });
    }
    return true;
  }

  /**
   * Build an echo-protected user message and deliver it to a live agent
   * (steer or followup). The rpcId is registered in the mirror's echo set so
   * the session's own `user/message` event is not mirrored back into the
   * Telegram chat. Returns the message (or null on failure).
   */
  async #inject(agent, content, forcedMode) {
    try {
      const rpcId = randomUUID();
      const userMessage = createUserMessage({
        content,
        source: { kind: 'user', rpcId },
      });
      await this.#mirror.rememberEcho(rpcId);
      await this.#deliverLive(agent, userMessage, forcedMode);
      return userMessage;
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] message injection failed:', error);
      return null;
    }
  }

  async #deliverLive(agent, userMessage, forcedMode) {
    const deliveryMode = forcedMode ?? this.#config.deliveryMode;
    if (deliveryMode === 'queue') {
      await agent.followup(userMessage);
    } else {
      await agent.steer(userMessage);
    }
  }

  /**
   * Resolve a session to a live agent, resuming a cold (persisted, not
   * running) session on demand. Shared by the router and the command
   * dispatcher (/cmd, /skill, /to). Returns the agent or null.
   */
  async ensureLiveAgent(sessionId) {
    const agent = this.#ctx.agents.get(sessionId);
    if (agent) return agent;
    return this.#resumeSession(sessionId);
  }

  /**
   * Resume a cold (persisted, not running) session: observe its header, mount
   * its preset, and publish a live agent. Returns the agent or null.
   */
  async #resumeSession(sessionId) {
    try {
      const observation = await this.#ctx.sessionQuery.observeSession(sessionId);
      const presetId = observation?.projections?.values?.agentPreset
        ?? observation?.header?.agentPreset;
      const presets = this.#ctx.get('agentPresets');
      const setup = async (agentCtx, agent) => {
        if (presets && typeof presets.mount === 'function' && presetId) {
          const resolvedId = (await presets.resolve(presetId)).id;
          await presets.mount(agentCtx, resolvedId);
        }
      };
      let provider;
      let model;
      try {
        const selection = this.#ctx.agentDefaultModel?.currentSelection?.() ?? {};
        provider = selection.provider;
        model = selection.model;
      } catch {
        provider = undefined;
        model = undefined;
      }
      const result = await this.#ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
        setup,
      });
      return result?.agent ?? null;
    } catch (error) {
      this.#logger.warn?.(
        `[dsh-im-multiagent] resume of session "${sessionId}" failed:`,
        error,
      );
      return null;
    }
  }

  // --- replies ---------------------------------------------------------------

  async #sendHint(message, key, params) {
    if (!this.#bot) return;
    const target = message?.replyTarget;
    if (!target) return;
    try {
      await this.#bot.sendText(target, this.#i18n.t(key, params));
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] hint delivery failed:', error);
    }
  }

  /** Reply to a message in the chat (used by the command dispatcher). */
  async reply(message, text) {
    if (!this.#bot || !message?.replyTarget) return;
    await this.#bot.sendText(message.replyTarget, text);
  }

  /**
   * Reply with inline buttons attached (stage 4a pickers). Returns the bot
   * send result so the caller can register the picker on the provider id.
   */
  async replyWithMarkup(message, text, replyMarkup) {
    if (!this.#bot || !message?.replyTarget) return undefined;
    return this.#bot.sendText(message.replyTarget, text, { replyMarkup });
  }

  /**
   * Acknowledge an inline-keyboard callback query (only for callback
   * messages; the bot shows no spinner once answered).
   */
  async answerCallback(message, { text } = {}) {
    if (!this.#bot || message?.kind !== 'callback' || !message.callbackQueryId) return;
    try {
      await this.#bot.answerCallbackQuery(message.callbackQueryId, { text });
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] answerCallbackQuery failed:', error);
    }
  }

  /**
   * Remove the inline buttons from a picker message (whole keyboard or
   * selection-dependent layout). Used after a picker selection settles.
   */
  async dismissPicker(message, target) {
    if (!this.#bot || !target || target.messageId === undefined) return;
    try {
      await this.#bot.editMessageReplyMarkup(target, { replyMarkup: { inline_keyboard: [] } });
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] editMessageReplyMarkup failed:', error);
    }
  }

  /** Drop one registered picker (one-shot: it settles on the first tap). */
  clearPicker(chatKey, messageId) {
    const byMessageId = this.#pickers.get(chatKey);
    if (!byMessageId) return;
    byMessageId.delete(String(messageId));
    if (byMessageId.size === 0) this.#pickers.delete(chatKey);
  }
}