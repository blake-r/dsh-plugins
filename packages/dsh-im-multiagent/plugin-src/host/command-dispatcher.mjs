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
// Stage 6 adds the remaining session commands: /stop, /steer, /enqueue,
// /compact, /new [workspace] [preset] <prompt>, /alias, and the roster lists
// /as, /ps, /ws with stable sorting and 1-based ordinal arguments. Delivery
// is delegated to the router (echo protection, indexing, cold resume);
// /follow, /unfollow (stage 7) and /hs (stage 7a) still hint "not yet".

import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { textFromHarnessContent } from '../../src/channels/shared/harness-client.mjs';
import { resolveSession, sortedSessions } from './session-list.mjs';
import { PLUGIN_COMMANDS } from './inbound-router.mjs';
import { STATUS_I18N_KEY } from './session-mirror.mjs';

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
        // `return await` keeps #router alive across the command's own awaits:
        // `finally { #router = null }` runs only after the promise settles.
        case 'to': return await this.#to(message, chatKey, args, router);
        case 'cmd': return await this.#cmd(message, chatKey, args, router);
        case 'skill': return await this.#skill(message, chatKey, args, router);
        case 'cancel': return await this.#cancel(message, chatKey, router);
        case 'start': return await this.#start(message);
        case 'help': return await this.#help(message);
        case 'status': return await this.#status(message);
        case 'version': return await this.#version(message);
        case 'as':
        case 'agents': return await this.#as(message);
        case 'ps':
        case 'presets': return await this.#ps(message);
        case 'ws':
        case 'workspaces': return await this.#ws(message);
        case 'stop': return await this.#stop(message, chatKey, args, router);
        case 'steer': return await this.#steer(message, chatKey, args, router);
        case 'enqueue': return await this.#enqueue(message, chatKey, args, router);
        case 'compact': return await this.#compact(message, chatKey, router);
        case 'new': return await this.#new(message, args, router);
        case 'alias': return await this.#alias(message, chatKey, args, router);
        case 'follow': return await this.#follow(message, args, router);
        case 'unfollow': return await this.#unfollow(message, router);
        case 'hs':
        case 'history': return await this.#hs(message, chatKey, args, router);
        default:
          if (/^(w|p)_[a-z0-9_]{1,32}$/.test(name)) {
            return await this.#drilldown(message, name, router);
          }
          return await this.#notYet(message, name);
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
        case 'to': return await this.#selectTo(picker, choice, isCallback, message, chatKey, router);
        case 'cmd': return await this.#selectCmd(picker, choice, isCallback, message, router);
        case 'skill': return await this.#selectSkill(picker, choice, isCallback, message, chatKey, router);
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

  // --- workspace / preset registries (stage 6) -------------------------------

  /** Workspaces from ctx.workspaceRegistry in stable sorted order. */
  #workspaceList() {
    try {
      const workspaces = this.#ctx.workspaceRegistry?.list?.() ?? [];
      const rows = Array.isArray(workspaces)
        ? workspaces.map((entity) => ({
            id: String(entity?.id ?? ''),
            title: String(entity?.title ?? '').trim(),
            path: String(entity?.path ?? '').trim(),
          }))
        : [];
      return rows.sort((left, right) => {
        const byTitle = (left.title || left.id).localeCompare(right.title || right.id);
        if (byTitle !== 0) return byTitle;
        const byPath = left.path.localeCompare(right.path);
        if (byPath !== 0) return byPath;
        return left.id.localeCompare(right.id);
      });
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] workspace list failed:', error);
      return [];
    }
  }

  /** Presets from agentPresets.list() in stable sorted order. */
  async #presetList() {
    const presets = this.#ctx.get('agentPresets');
    if (!presets?.list) return [];
    try {
      const rows = await presets.list();
      const clean = Array.isArray(rows)
        ? rows.map((preset) => ({
            id: String(preset?.id ?? ''),
            name: String(preset?.name ?? '').trim(),
            description: String(preset?.description ?? '').trim(),
          }))
        : [];
      return clean.sort((left, right) => {
        const byName = (left.name || left.id).localeCompare(right.name || right.id);
        if (byName !== 0) return byName;
        return left.id.localeCompare(right.id);
      });
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] preset list failed:', error);
      return [];
    }
  }

  /** 1-based ordinal (from the stable order) or title/path/id match. */
  async #resolveWorkspace(reference) {
    const workspaces = this.#workspaceList();
    const text = String(reference ?? '').trim();
    if (/^\d+$/.test(text)) return workspaces[Number(text) - 1] ?? null;
    if (!text) return null;
    const needle = text.toLowerCase();
    const byTitle = workspaces.find((workspace) => workspace.title.toLowerCase() === needle);
    if (byTitle) return byTitle;
    const byPath = workspaces.find((workspace) => workspace.path === text);
    if (byPath) return byPath;
    return workspaces.find((workspace) => workspace.id === text) ?? null;
  }

  /** Does the token look like a workspace (matches one)? */
  async #matchWorkspace(reference) {
    return (await this.#resolveWorkspace(reference)) !== null;
  }

  /** 1-based ordinal (from the stable order) or id/name match. */
  async #resolvePreset(reference) {
    const presets = await this.#presetList();
    const text = String(reference ?? '').trim();
    if (/^\d+$/.test(text)) return presets[Number(text) - 1] ?? null;
    if (!text) return null;
    const needle = text.toLowerCase();
    const byId = presets.find((preset) => preset.id.toLowerCase() === needle);
    if (byId) return byId;
    return presets.find((preset) => preset.name.toLowerCase() === needle) ?? null;
  }

  /** Does the token look like a preset (matches one)? */
  async #matchPreset(reference) {
    return (await this.#resolvePreset(reference)) !== null;
  }

  /** The bot's default workspace (config), else null. */
  async #defaultWorkspace() {
    const configured = this.#config.defaults?.workspace;
    if (!configured) return null;
    return this.#resolveWorkspace(configured);
  }

  /** The bot's default preset (config), else the presets.defaultId. */
  async #defaultPresetId() {
    const configured = this.#config.defaults?.preset;
    if (configured) {
      return (await this.#resolvePreset(configured))?.id ?? null;
    }
    return this.#ctx.get('agentPresets')?.defaultId ?? null;
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

  // --- /as / /ps / /ws (section 9: stable sorting, 1-based ordinals) ---------

  async #as(message) {
    const sessions = sortedSessions(this.#mirror.sessions());
    const lines = sessions.map(({ sessionId, entry }, index) => {
      const name = entry?.name ?? sessionId;
      const status = this.#i18n.t(STATUS_I18N_KEY[entry?.status] ?? 'status.cold');
      const workspace = entry?.workspace ? ` · ${entry.workspace}` : '';
      return `${index + 1}. ${name} — ${status}${workspace}`;
    });
    const header = this.#i18n.t('list.as-header', { n: sessions.length });
    return this.#reply(message, `${header}\n${lines.join('\n')}`);
  }

  async #ps(message) {
    const presets = await this.#presetList();
    const lines = presets.map((preset, index) => {
      const name = preset.name ?? preset.id;
      const description = preset.description ? ` — ${preset.description}` : '';
      return `${index + 1}. ${name} [${preset.id}]${description}`;
    });
    const header = this.#i18n.t('list.ps-header', { n: presets.length });
    return this.#reply(message, `${header}\n${lines.join('\n')}`);
  }

  async #ws(message) {
    const workspaces = this.#workspaceList();
    const lines = workspaces.map((workspace, index) => (
      `${index + 1}. ${workspace.title} — ${workspace.path}`
    ));
    const header = this.#i18n.t('list.ws-header', { n: workspaces.length });
    return this.#reply(message, `${header}\n${lines.join('\n')}`);
  }

  // --- mirror toggle (stage 7) ----------------------------------------------

  /**
   * /follow (or /follow on): enable mirroring and send a snapshot (overview +
   * last assistant message per session). When already enabled — refresh
   * (Q46): the snapshot is re-sent; the old snapshot messages stay (reply
   * routing keeps working, pruning cleans them up).
   */
  async #follow(message, args, router) {
    const arg = String(args ?? '').trim().toLowerCase();
    if (arg === 'off') {
      return this.#unfollow(message, router);
    }
    if (arg && arg !== 'on') {
      return router?.reply(message, this.#i18n.t('hint.follow-usage'));
    }
    await this.#state.setMirroring(true);
    await this.#mirror.snapshot();
    return router?.reply(message, this.#i18n.t('hint.follow-on'));
  }

  /**
   * /unfollow (or /follow off): disable mirroring and finalize active status
   * placeholders. When already disabled — a hint (Q46).
   */
  async #unfollow(message, router) {
    if (this.#state.mirroring().enabled !== true) {
      return router?.reply(message, this.#i18n.t('hint.follow-not-on'));
    }
    await this.#state.setMirroring(false);
    await this.#mirror.finalize();
    return router?.reply(message, this.#i18n.t('hint.follow-off'));
  }

  // --- /hs (stage 7a) -------------------------------------------------------

  /**
   * /hs [N] [M] — last N messages of a session (plan 6.6, Q3).
   * Addressing: reply → sessionId from the MessageIndex; without a reply the
   * first token is a session ordinal (from /as) or name/alias, and the second
   * token is the message count. Default count 3, max 50. Source is a single
   * ctx.sessionQuery.readSurface(sessionId) call — no agent resume. The
   * rendered history is sent through the router so it is indexed (reply
   * routing works on history lines).
   */
  async #hs(message, chatKey, args, router) {
    const tokens = String(args ?? '').trim().split(/\s+/).filter(Boolean);
    const replySessionId = this.#replySession(message, chatKey);
    let sessionId = replySessionId;
    let count = 3;
    if (tokens.length > 0) {
      if (/^\d+$/.test(tokens[0])) {
        if (replySessionId) {
          // reply + number → the number is the message count
          count = Number(tokens[0]);
        } else {
          // no reply + number → session ordinal; second token is the count
          sessionId = resolveSession(this.#mirror.sessions(), tokens[0])?.sessionId;
          if (tokens.length > 1 && /^\d+$/.test(tokens[1])) count = Number(tokens[1]);
        }
      } else {
        // name/alias; second token is the count
        sessionId = resolveSession(this.#mirror.sessions(), tokens[0])?.sessionId;
        if (tokens.length > 1 && /^\d+$/.test(tokens[1])) count = Number(tokens[1]);
      }
    }
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.hs-usage'));
    count = Math.max(1, Math.min(50, count));

    let surface;
    try {
      surface = await this.#ctx.sessionQuery?.readSurface?.(sessionId);
    } catch {
      return router?.reply(message, this.#i18n.t('hint.session-gone'));
    }
    if (!surface) return router?.reply(message, this.#i18n.t('hint.session-gone'));

    const events = (surface.events ?? []).filter((event) => {
      if (event?.type === 'user/message') return textFromHarnessContent(event.data?.content) !== '';
      if (event?.type === 'assistant/message') return textFromHarnessContent(event.data?.message?.content) !== '';
      return false;
    });
    if (events.length === 0) return router?.reply(message, this.#i18n.t('hint.no-messages'));

    const name = this.#displayName(sessionId);
    const lines = [];
    const skipped = Math.max(0, events.length - count);
    for (const event of events.slice(-count)) {
      const text = event.type === 'user/message'
        ? textFromHarnessContent(event.data?.content)
        : textFromHarnessContent(event.data?.message?.content);
      const time = this.#formatTime(event.time);
      lines.push(this.#i18n.t('history.format', { name, time, text }));
    }
    const header = skipped > 0
      ? this.#i18n.t('hint.more-messages', { m: skipped })
      : null;
    const body = [header, ...lines].filter(Boolean).join('\n');
    // Q3: the rendered history is indexed so reply routing works on it.
    const sent = await router?.replyWithMarkup(message, body);
    const providerId = sent?.providerMessageIds?.[0] ?? sent?.messageId;
    if (providerId !== undefined) {
      await this.#index.put(chatKey, {
        messageId: String(providerId),
        sessionId,
        direction: 'out',
      });
    }
    return undefined;
  }

  #formatTime(time) {
    if (!Number.isFinite(Number(time))) return '—';
    const date = new Date(Number(time));
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // --- menu drill-downs (stage 6a) ------------------------------------------

  /**
   * /w_<slug> — sessions of the workspace whose title slugifies to <slug>;
   * /p_<slug> — preset info + sessions using it. Slugification mirrors
   * MenuBuilder: lowercase [a-z0-9_], no Cyrillic, base truncated to 30.
   */
  async #drilldown(message, name, router) {
    const [prefix, slug] = name.split('_', 2);
    if (prefix === 'w') {
      const workspace = this.#workspaceList().find((row) => this.#slugify(row.title) === slug);
      if (!workspace) return router?.reply(message, this.#i18n.t('hint.drilldown-miss'));
      const sessions = sortedSessions(this.#mirror.sessions())
        .filter(({ entry }) => entry?.workspace === workspace.path || entry?.workspace === workspace.id)
        .map(({ sessionId, entry }) => {
          const name = entry?.name ?? sessionId;
          const status = this.#i18n.t(STATUS_I18N_KEY[entry?.status] ?? 'status.cold');
          return `- ${name} [${status}]`;
        });
      const header = this.#i18n.t('list.ws-drilldown', {
        title: workspace.title,
        n: sessions.length,
      });
      return router?.reply(message, `${header}\n${sessions.join('\n')}`);
    }
    const presets = await this.#presetList();
    const preset = presets.find((row) => this.#slugify(row.name) === slug || this.#slugify(row.id) === slug);
    if (!preset) return router?.reply(message, this.#i18n.t('hint.drilldown-miss'));
    const sessions = sortedSessions(this.#mirror.sessions())
      .filter(({ entry }) => entry?.preset === preset.id)
      .map(({ sessionId, entry }) => {
        const name = entry?.name ?? sessionId;
        const status = this.#i18n.t(STATUS_I18N_KEY[entry?.status] ?? 'status.cold');
        return `- ${name} [${status}]`;
      });
    const header = this.#i18n.t('list.ps-drilldown', {
      name: preset.name || preset.id,
      n: sessions.length,
    });
    const description = preset.description ? `\n${preset.description}` : '';
    return router?.reply(message, `${header}\n${sessions.join('\n')}${description}`);
  }

  /** MenuBuilder-compatible title slug (null when not slugifiable). */
  #slugify(title) {
    const base = String(title ?? '').trim().toLowerCase();
    if (!base || /[а-яё]/i.test(base) || !/^[a-z0-9_]{1,32}$/.test(base)) return null;
    return base.slice(0, 30);
  }

  // --- /stop ----------------------------------------------------------------

  async #stop(message, chatKey, args, router) {
    const sessionId = args
      ? resolveSession(this.#mirror.sessions(), args)?.sessionId
      : this.#replySession(message, chatKey);
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.cmd-reply'));
    const agent = this.#ctx.agents?.get?.(sessionId);
    if (!agent || typeof agent.cancel !== 'function') {
      return router?.reply(message, this.#i18n.t('hint.no-active-turn'));
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true });
    return router?.reply(message, this.#i18n.t('hint.stop-ok', {
      name: this.#displayName(sessionId),
    }));
  }

  // --- /steer / /enqueue -----------------------------------------------------

  async #steer(message, chatKey, args, router) {
    const text = String(args ?? '').trim();
    if (!text) return router?.reply(message, this.#i18n.t('hint.text-only'));
    const sessionId = this.#replySession(message, chatKey);
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.cmd-reply'));
    if (!(await router?.deliverToSession(sessionId, text, message, chatKey, { mode: 'steer' }))) {
      return router?.reply(message, this.#i18n.t('hint.session-gone'));
    }
    return router?.reply(message, '✓');
  }

  async #enqueue(message, chatKey, args, router) {
    const text = String(args ?? '').trim();
    if (!text) return router?.reply(message, this.#i18n.t('hint.text-only'));
    const sessionId = this.#replySession(message, chatKey);
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.cmd-reply'));
    const live = this.#ctx.agents?.get?.(sessionId);
    if (live && this.#pendingCount(live) >= 10) {
      return router?.reply(message, this.#i18n.t('hint.queue-full'));
    }
    if (!(await router?.deliverToSession(sessionId, text, message, chatKey, { mode: 'queue' }))) {
      return router?.reply(message, this.#i18n.t('hint.session-gone'));
    }
    return router?.reply(message, '✓');
  }

  /** Pending inbox work (Q26): next-turn + next-step, read from agent.inbox. */
  #pendingCount(agent) {
    const inbox = agent?.inbox;
    if (!inbox) return 0;
    const nextTurn = inbox.nextTurn;
    const nextStep = inbox.nextStep;
    return (Array.isArray(nextTurn) ? nextTurn.length : 0)
      + (Array.isArray(nextStep) ? nextStep.length : 0);
  }

  // --- /compact --------------------------------------------------------------

  async #compact(message, chatKey, router) {
    const sessionId = this.#replySession(message, chatKey);
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.cmd-reply'));
    const agent = this.#ctx.agents?.get?.(sessionId);
    if (!agent) return router?.reply(message, this.#i18n.t('hint.cold-compact'));
    if (typeof this.#ctx.compaction?.compactNow !== 'function') {
      return router?.reply(message, this.#i18n.t('hint.cold-compact'));
    }
    try {
      // Never-abort signal for the manual compaction request (Q15).
      const result = await this.#ctx.compaction.compactNow(agent, AbortSignal.any([]), 'dsh-im-multiagent');
      if (result === null) return router?.reply(message, this.#i18n.t('hint.compact-nothing'));
      return router?.reply(message, this.#i18n.t('hint.compact-ok', {
        n: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
      }));
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] compaction failed:', error);
      return router?.reply(message, this.#i18n.t('hint.cold-compact'));
    }
  }

  // --- /new [workspace] [preset] <prompt> ------------------------------------

  async #new(message, args, router) {
    const tokens = String(args ?? '').trim().split(/\s+/).filter(Boolean);
    const { index, workspaceRef, presetRef } = await this.#consumeNewArgs(tokens);
    const prompt = tokens.slice(index).join(' ').trim();
    if (!prompt) {
      return router?.reply(message, this.#i18n.t('hint.new-prompt-required'));
    }
    const outcome = await this.#createNewSession(workspaceRef, presetRef, prompt);
    if (!outcome.ok) {
      const key = outcome.reason === 'followup'
        ? 'hint.new-followup-failed'
        : outcome.reason === 'workspace'
          ? 'hint.new-workspace-required'
          : 'hint.new-create-failed';
      return router?.reply(message, this.#i18n.t(key, {
        name: outcome.sessionId ?? '',
      }));
    }
    return router?.reply(message, this.#i18n.t('hint.new-ok', { name: outcome.sessionId }));
  }

  /**
   * Consume workspace/preset arity from the head of the token list (Q9): a
   * leading workspace, then a leading preset; a token that matches neither is
   * left as the prompt start. Returns the first prompt-token index and which
   * references were consumed.
   */
  async #consumeNewArgs(tokens) {
    let index = 0;
    let workspaceRef;
    let presetRef;
    if (index < tokens.length && await this.#matchWorkspace(tokens[index])) {
      workspaceRef = tokens[index];
      index += 1;
      if (index < tokens.length && await this.#matchPreset(tokens[index])) {
        presetRef = tokens[index];
        index += 1;
      }
    } else if (index < tokens.length && await this.#matchPreset(tokens[index])) {
      presetRef = tokens[index];
      index += 1;
    }
    return { index, workspaceRef, presetRef };
  }

  /**
   * Resolve and create the session through ctx.agents.create (Q29). A failed
   * create reports 'create'; a failed first prompt reports 'followup' and the
   * session stays addressable; a missing workspace reports 'workspace'.
   */
  async #createNewSession(workspaceRef, presetRef, prompt) {
    const workspace = workspaceRef
      ? await this.#resolveWorkspace(workspaceRef)
      : await this.#defaultWorkspace();
    if (!workspace) {
      return { ok: false, reason: 'workspace' };
    }
    let presetId = presetRef
      ? (await this.#resolvePreset(presetRef))?.id
      : await this.#defaultPresetId();
    let agentOptions = {};
    try {
      const selection = this.#ctx.agentDefaultModel?.currentSelection?.() ?? {};
      if (selection.provider) agentOptions.provider = selection.provider;
      if (selection.model) agentOptions.model = selection.model;
    } catch {
      // model selection is optional
    }
    const setup = async (agentCtx) => {
      const presets = this.#ctx.get('agentPresets');
      if (presets?.mount && presetId) await presets.mount(agentCtx, presetId);
    };
    let agent;
    try {
      const handle = await this.#ctx.agents.create({
        agentOptions,
        meta: { cwd: workspace.path, ...(presetId ? { agentPreset: presetId } : {}) },
        setup,
      });
      agent = handle?.agent ?? handle ?? null;
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] /new create failed:', error);
      return { ok: false, reason: 'create' };
    }
    const sessionId = agent?.session?.id ?? null;
    if (!agent) return { ok: false, reason: 'create' };
    if (typeof agent.followup !== 'function') return { ok: true, sessionId };
    const rpcId = randomUUID();
    const userMessage = createUserMessage({
      content: prompt,
      source: { kind: 'user', rpcId },
    });
    try {
      await this.#mirror.rememberEcho(rpcId);
      await agent.followup(userMessage);
    } catch (error) {
      this.#logger.warn?.('[dsh-im-multiagent] /new first prompt failed:', error);
      return { ok: false, reason: 'followup', sessionId };
    }
    return { ok: true, sessionId };
  }

  // --- /alias ----------------------------------------------------------------

  async #alias(message, chatKey, args, router) {
    const sessionId = this.#replySession(message, chatKey);
    if (!sessionId) return router?.reply(message, this.#i18n.t('hint.cmd-reply'));
    const name = String(args ?? '').trim();
    if (!name) {
      await this.#state.setMirrorEntry(sessionId, { alias: null });
      void router?.menuBuilder?.onSessionsChanged();
      return router?.reply(message, this.#i18n.t('hint.alias-ok', { alias: name }));
    }
    if (name.length > 32 || !/^[a-z0-9_а-яё]+$/i.test(name)) {
      return router?.reply(message, this.#i18n.t('hint.alias-invalid'));
    }
    const lower = name.toLowerCase();
    if (PLUGIN_COMMANDS.has(lower) || this.#state.menuSlugFor(lower)) {
      return router?.reply(message, this.#i18n.t('hint.alias-taken'));
    }
    for (const [id, entry] of Object.entries(this.#mirror.sessions())) {
      if (id !== sessionId && String(entry?.alias ?? '').toLowerCase() === lower) {
        return router?.reply(message, this.#i18n.t('hint.alias-taken'));
      }
    }
    await this.#state.setMirrorEntry(sessionId, { alias: name });
    void router?.menuBuilder?.onSessionsChanged();
    return router?.reply(message, this.#i18n.t('hint.alias-ok', { alias: name }));
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
      const status = this.#i18n.t(STATUS_I18N_KEY[entry?.status] ?? 'status.cold');
      return `${index + 1}. ${name} — ${status}`;
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