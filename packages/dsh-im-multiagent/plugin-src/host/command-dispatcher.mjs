// dsh-im-multiagent CommandDispatcher (plan sections 4.1, 4.3, 9).
//
// Stage 4 scope: the addressing-critical commands the InboundRouter needs
// (/to, /cancel) plus the info commands (/start, /help, /status, /version).
// Stage 4a adds the inline pickers (plan 4.1/4.3): /to without text sends a
// keyboard of session buttons, /cmd (reply) and /skill (reply) send keyboards
// of the agent's commands and user-invocable skills. A tap on a button is a
// callback_query; a numbered text reply on the picker message works as the
// fallback. Both paths land in handlePickerSelection.
//
// The remaining commands (/stop, /steer, /enqueue, /compact, /new, /alias,
// /as, /ps, /ws, /hs, /follow, /unfollow) reply with a "not yet" hint so the
// router's rule 0 never leaks a command into a session.

import { resolveSession, sortedSessions } from './session-list.mjs';

const NOT_YET = 'not-yet';
const NO_SIGNAL = Object.freeze({ aborted: false });

/** Telegram InlineKeyboardMarkup from { text, callback_data } buttons. */
function inlineKeyboard(buttons, perRow = 2) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += perRow) {
    rows.push(buttons.slice(index, index + perRow));
  }
  return { inline_keyboard: rows };
}

/** Resolve a provider message id from a bot send result (either shape). */
function providerMessageId(result) {
  const first = result?.providerMessageIds?.[0];
  if (first !== undefined && first !== null && first !== '') return String(first);
  return Number.isSafeInteger(result?.messageId) ? String(result.messageId) : null;
}

export class CommandDispatcher {
  #ctx;
  #config;
  #state;
  #index;
  #mirror;
  #i18n;
  #logger;
  #router = null;

  constructor({ ctx, config, state, index, mirror, i18n, logger = console }) {
    this.#ctx = ctx;
    this.#config = config ?? {};
    this.#state = state;
    this.#index = index;
    this.#mirror = mirror;
    this.#i18n = i18n;
    this.#logger = logger;
  }

  /** Rule 0 entry: dispatch a plugin command message. */
  async handle(message, chatKey, { router } = {}) {
    this.#router = router;
    try {
      const text = String(message?.content ?? '').trim();
      const [rawName, ...rest] = text.slice(1).split(/\s+/);
      const name = rawName.toLowerCase();
      const args = rest.join(' ').trim();

      switch (name) {
        case 'to': return this.#to(message, chatKey, args, router);
        case 'cmd': return this.#cmd(message, chatKey, args, router);
        case 'skill': return this.#skill(message, chatKey, args, router);
        case 'cancel': return this.#cancel(message, chatKey, router);
        case 'start': return this.#start(message);
        case 'help': return this.#help(message);
        case 'status': return this.#status(message);
        case 'version': return this.#version(message);
        default: return this.#notYet(message, name);
      }
    } finally {
      this.#router = null;
    }
  }

  /**
   * Picker selection (stage 4a): a callback tap or a numbered text reply on a
   * picker message. The picker was registered with { kind, sessionId } when
   * the keyboard was sent; the choice is the callback_data (callback) or the
   * reply text. One-shot: the picker entry is dropped before the selection
   * settles.
   */
  async handlePickerSelection(picker, message, chatKey, { router } = {}) {
    this.#router = router;
    try {
      const isCallback = message?.kind === 'callback';
      const choice = isCallback
        ? String(message?.callbackData ?? '').trim()
        : String(message?.content ?? '').trim();
      const pickerMessageId = isCallback
        ? message?.callbackMessageId
        : message?.replyTo?.messageId;
      if (pickerMessageId !== undefined) {
        router?.clearPicker(chatKey, pickerMessageId);
      }
      switch (picker?.kind) {
        case 'to': return this.#selectTo(picker, choice, isCallback, message, chatKey, router);
        case 'cmd': return this.#selectCmd(picker, choice, isCallback, message, router);
        case 'skill': return this.#selectSkill(picker, choice, isCallback, message, chatKey, router);
        default: return undefined;
      }
    } finally {
      this.#router = null;
    }
  }

  // --- /to -------------------------------------------------------------------

  async #to(message, chatKey, args, router) {
    if (!args) return this.#sendTargetPicker(message, chatKey, router);
    const [reference, ...textParts] = args.split(/\s+/);
    const text = textParts.join(' ').trim();
    if (!text) return router?.reply(message, this.#i18n.t('hint.text-only'));
    const hit = resolveSession(this.#mirror.sessions(), reference);
    if (!hit) return router?.reply(message, this.#i18n.t('hint.session-gone'));
    return router?.deliverToSession(hit.sessionId, text, message, chatKey);
  }

  /** /to without text: keyboard of every mirror session (plan 4.1). */
  async #sendTargetPicker(message, chatKey, router) {
    const sessions = sortedSessions(this.#mirror.sessions());
    if (sessions.length === 0) return router?.reply(message, this.#i18n.t('hint.no-messages'));
    const buttons = sessions.map(({ sessionId, entry }) => ({
      text: `🤖 ${entry?.name ?? sessionId}`,
      callback_data: `to:${sessionId}`,
    }));
    return this.#sendPicker(message, chatKey, 'to', null, this.#i18n.t('picker.to-title'),
      buttons, { perRow: 1 }, router);
  }

  // --- /cmd / /skill ---------------------------------------------------------

  async #cmd(message, chatKey, args, router) {
    const sessionId = this.#replySession(message, chatKey);
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.cmd-reply'));
    const agent = await router?.ensureLiveAgent(sessionId);
    if (!agent) return router?.reply(message, this.#i18n.t('hint.session-gone'));
    const commands = this.#commandList(agent);
    const name = this.#displayName(sessionId);
    if (args) {
      const hit = this.#matchList(commands, args, (command) => command.name);
      if (!hit) return router?.reply(message, this.#i18n.t('hint.command-not-found', { name }));
      return this.#runCommand(agent, hit.name, '', message, router);
    }
    if (commands.length === 0) {
      return router?.reply(message, this.#i18n.t('hint.no-commands', { name }));
    }
    const buttons = commands.map((command, index) => ({
      text: `${index + 1}. /${command.name}`,
      callback_data: `cmd:${command.name}`,
    }));
    return this.#sendPicker(message, chatKey, 'cmd', sessionId,
      this.#i18n.t('picker.cmd-title', { name, n: commands.length }), buttons, {}, router);
  }

  async #skill(message, chatKey, args, router) {
    const sessionId = this.#replySession(message, chatKey);
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.cmd-reply'));
    const agent = await router?.ensureLiveAgent(sessionId);
    if (!agent) return router?.reply(message, this.#i18n.t('hint.session-gone'));
    const skills = await this.#skillList(agent);
    const name = this.#displayName(sessionId);
    if (args) {
      const hit = this.#matchList(skills, args, (skill) => skill.name);
      if (!hit) return router?.reply(message, this.#i18n.t('hint.skill-unavailable'));
      return this.#runSkill(agent, hit.name, message, chatKey, router);
    }
    if (skills.length === 0) {
      return router?.reply(message, this.#i18n.t('hint.no-skills', { name }));
    }
    const buttons = skills.map((skill, index) => ({
      text: `${index + 1}. ${skill.name}`,
      callback_data: `skill:${skill.name}`,
    }));
    return this.#sendPicker(message, chatKey, 'skill', sessionId,
      this.#i18n.t('picker.skill-title', { name, n: skills.length }), buttons, {}, router);
  }

  // --- picker selection ------------------------------------------------------

  async #selectTo(picker, choice, isCallback, message, chatKey, router) {
    const bare = pickerCallbackValue(choice, 'to');
    const sessionId = isCallback ? bare : (resolveSession(this.#mirror.sessions(), bare)?.sessionId ?? '');
    const entry = sessionId ? this.#mirror.sessions()[sessionId] : null;
    if (!entry) {
      await router?.answerCallback(message, { text: this.#i18n.t('hint.session-gone') });
      return;
    }
    router?.setPendingTarget(chatKey, sessionId);
    if (isCallback) {
      await router?.answerCallback(message, { text: '✓' });
      await this.#dismissPicker(message, router);
    }
    return router?.reply(message, this.#i18n.t('picker.target-set', {
      name: entry?.name ?? sessionId,
    }));
  }

  async #selectCmd(picker, choice, isCallback, message, router) {
    const sessionId = picker?.sessionId;
    if (!sessionId) return this.#selectionFailed(message, router);
    const agent = await router?.ensureLiveAgent(sessionId);
    if (!agent) return this.#selectionFailed(message, router);
    const commands = this.#commandList(agent);
    const hit = this.#matchList(commands, pickerCallbackValue(choice, 'cmd'), (command) => command.name);
    if (!hit) {
      await router?.answerCallback(message, {
        text: this.#i18n.t('hint.command-not-found', { name: this.#displayName(sessionId) }),
      });
      return;
    }
    if (isCallback) {
      await router?.answerCallback(message, { text: '✓' });
      await this.#dismissPicker(message, router);
    }
    return this.#runCommand(agent, hit.name, '', message, router);
  }

  async #selectSkill(picker, choice, isCallback, message, chatKey, router) {
    const sessionId = picker?.sessionId;
    if (!sessionId) return this.#selectionFailed(message, router);
    const agent = await router?.ensureLiveAgent(sessionId);
    if (!agent) return this.#selectionFailed(message, router);
    const bare = pickerCallbackValue(choice, 'skill');
    const skills = await this.#skillList(agent);
    if (!this.#matchList(skills, bare, (skill) => skill.name)) {
      await router?.answerCallback(message, { text: this.#i18n.t('hint.skill-unavailable') });
      return;
    }
    if (isCallback) {
      await router?.answerCallback(message, { text: '✓' });
      await this.#dismissPicker(message, router);
    }
    return this.#runSkill(agent, bare, message, chatKey, router);
  }

  async #selectionFailed(message, router) {
    await router?.answerCallback(message, { text: this.#i18n.t('hint.cmd-reply') });
  }

  // --- execution -------------------------------------------------------------

  async #runCommand(agent, name, argumentText, message, router) {
    if (!this.#ctx.commands?.execute) {
      return router?.reply(message, this.#i18n.t('hint.command-not-found', {
        name: this.#displayName(agent.sessionId),
      }));
    }
    const line = argumentText ? `/${name} ${argumentText}` : `/${name}`;
    try {
      const settled = await this.#ctx.commands.execute(agent, line, [], NO_SIGNAL);
      if (!settled) {
        return router?.reply(message, this.#i18n.t('hint.command-not-found', {
          name: this.#displayName(agent.sessionId),
        }));
      }
      const result = settled.result ?? {};
      const text = String(result.text ?? '').trim();
      if (text) return router?.reply(message, text);
      return router?.reply(message, result.kind === 'error'
        ? this.#i18n.t('hint.command-not-found', { name: this.#displayName(agent.sessionId) })
        : '✓');
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] command execution failed:', error);
      return router?.reply(message, this.#i18n.t('hint.command-not-found', {
        name: this.#displayName(agent.sessionId),
      }));
    }
  }

  async #runSkill(agent, name, message, chatKey, router) {
    const registry = this.#skillsFor(agent);
    if (!registry?.get) {
      return router?.reply(message, this.#i18n.t('hint.skill-unavailable'));
    }
    try {
      const skill = await registry.get(name, {
        cwd: agent?.session?.header?.cwd,
        scope: agent,
      });
      if (!skill) return router?.reply(message, this.#i18n.t('hint.skill-unavailable'));
      const content = String(skill.content ?? '').trim();
      if (!content) return router?.reply(message, this.#i18n.t('hint.skill-unavailable'));
      return router?.deliverToSession(agent.sessionId, content, message, chatKey);
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] skill load failed:', error);
      return router?.reply(message, this.#i18n.t('hint.skill-unavailable'));
    }
  }

  // --- picker plumbing -------------------------------------------------------

  /** Send the keyboard, register the picker, fall back to a numbered list. */
  async #sendPicker(message, chatKey, kind, sessionId, title, buttons, { perRow = 2 }, router) {
    const sent = await router?.replyWithMarkup(message, title, inlineKeyboard(buttons, perRow));
    const sentId = providerMessageId(sent);
    if (sentId) return router?.registerPicker(chatKey, sentId, { kind, sessionId });
    // Text fallback: the numbered list mirrors the buttons; a reply with the
    // number or name executes the same selection via handlePickerSelection.
    const lines = buttons.map((button, index) => `${index + 1}. ${button.text}`);
    const sentList = await router?.reply(message, `${title}\n${lines.join('\n')}`);
    const listId = providerMessageId(sentList);
    if (listId) router?.registerPicker(chatKey, listId, { kind, sessionId });
    return undefined;
  }

  async #dismissPicker(message, router) {
    await router?.dismissPicker(message, {
      chatId: message?.replyTarget?.chatId,
      messageId: message?.callbackMessageId,
    });
  }

  // --- services --------------------------------------------------------------

  #replySession(message, chatKey) {
    const replyMessageId = message?.replyTo?.messageId;
    if (!replyMessageId) return null;
    return this.#index.lookup(chatKey, replyMessageId)?.sessionId ?? null;
  }

  #displayName(sessionId) {
    return this.#mirror.sessions()[sessionId]?.name ?? sessionId;
  }

  #commandList(agent) {
    try {
      return this.#ctx.commands?.list?.(agent) ?? [];
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] command list failed:', error);
      return [];
    }
  }

  async #skillList(agent) {
    const registry = this.#skillsFor(agent);
    if (!registry?.list) return [];
    try {
      const summaries = await registry.list({
        cwd: agent?.session?.header?.cwd,
        scope: agent,
      });
      return (Array.isArray(summaries) ? summaries : [])
        .filter((skill) => skill?.invocation?.userInvocable !== false);
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] skill list failed:', error);
      return [];
    }
  }

  /** The agent's skill registry: its preset service, else the host service. */
  #skillsFor(agent) {
    const presets = this.#ctx.get('agentPresets');
    if (presets && typeof presets.serviceFor === 'function') {
      try {
        const scoped = presets.serviceFor(agent, 'skills');
        if (scoped) return scoped;
      } catch {
        // fall through to the host service
      }
    }
    return this.#ctx.get('skills') ?? this.#ctx.skills;
  }

  /** Match a picker choice: 1-based number or exact name, case-insensitive. */
  #matchList(items, choice, nameOf) {
    const text = String(choice ?? '').trim();
    if (!text) return null;
    const digits = /^\d+$/.test(text);
    if (digits) {
      const item = items[Number(text) - 1];
      return item ? item : null;
    }
    const needle = text.toLowerCase();
    return items.find((item) => String(nameOf(item)).toLowerCase() === needle) ?? null;
  }

  // --- /cancel ---------------------------------------------------------------

  async #cancel(message, chatKey, router) {
    router?.clearPending(chatKey);
    return router?.reply(message, '✓');
  }

  // --- info commands ---------------------------------------------------------

  async #start(message) {
    const greeting = this.#i18n.t('start.greeting');
    const hint = this.#i18n.t('start.hint');
    return this.#reply(message, `${greeting}\n${hint}`);
  }

  async #help(message) {
    const commands = [
      '/as', '/to <имя|N> <текст>', '/hs', '/follow', '/unfollow',
      '/stop', '/steer', '/enqueue', '/compact', '/new', '/alias',
      '/cmd', '/skill', '/cancel', '/status', '/version',
    ];
    return this.#reply(message, commands.join('\n'));
  }

  async #status(message) {
    const sessions = sortedSessions(this.#mirror.sessions());
    const lines = sessions.map(({ sessionId, entry }, index) => {
      const name = entry?.name ?? sessionId;
      const status = entry?.status ?? 'cold';
      return `${index + 1}. ${name} — ${this.#i18n.t(`status.${status}`)}`;
    });
    const header = this.#i18n.t('status.header', { n: sessions.length });
    return this.#reply(message, `${header}\n${lines.join('\n')}`);
  }

  async #version(message) {
    return this.#reply(message, `dsh-im-multiagent ${this.#config.version ?? '0.1.0'}`);
  }

  async #notYet(message, name) {
    return this.#reply(message, this.#i18n.t(NOT_YET, { cmd: `/${name}` }));
  }

  async #reply(message, text) {
    if (!message?.replyTarget) return;
    await this.#router?.reply(message, text);
  }
}

/** Strip the `kind:` prefix from a callback_data value when present. */
function pickerCallbackValue(choice, kind) {
  const text = String(choice ?? '').trim();
  return text.startsWith(`${kind}:`) ? text.slice(kind.length + 1) : text;
}