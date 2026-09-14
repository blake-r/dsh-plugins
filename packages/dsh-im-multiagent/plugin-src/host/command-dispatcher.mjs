// dsh-im-multiagent CommandDispatcher (plan section 9).
//
// Stage 4 scope: the addressing-critical commands the InboundRouter needs to
// be complete end-to-end (/to, /cancel) plus the info commands (/start,
// /help, /status, /version). The full command set (/stop, /steer, /enqueue,
// /compact, /new, /alias, /as, /ps, /ws, /hs, /follow, /unfollow, /cmd,
// /skill) lands in stage 6; those names reply with a "not yet" hint so the
// router's rule 0 never leaks a command into a session.

import { resolveSession, sortedSessions } from './session-list.mjs';

const NOT_YET = 'not-yet';

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

  /** Picker selection (stage 4a fills the registry; the hook is live). */
  async handlePickerSelection(picker, message, chatKey, { router } = {}) {
    void picker;
    void message;
    void chatKey;
    void router;
    return undefined;
  }

  // --- /to -------------------------------------------------------------------

  async #to(message, chatKey, args, router) {
    if (!args) {
      // Stage 4a shows inline buttons here; for now reply with the numbered
      // list and the direct form.
      const sessions = sortedSessions(this.#mirror.sessions());
      if (sessions.length === 0) return router?.reply(message, this.#i18n.t('hint.no-messages'));
      const lines = sessions.map(({ sessionId, entry }, index) => {
        const name = entry?.name ?? sessionId;
        const status = entry?.status ?? 'cold';
        return `${index + 1}. ${name} — ${this.#i18n.t(`status.${status}`)}`;
      });
      return router?.reply(message, `${this.#i18n.t('picker.to-title')}\n${lines.join('\n')}`);
    }
    const [reference, ...textParts] = args.split(/\s+/);
    const text = textParts.join(' ').trim();
    if (!text) return router?.reply(message, this.#i18n.t('hint.text-only'));
    const hit = resolveSession(this.#mirror.sessions(), reference);
    if (!hit) return router?.reply(message, this.#i18n.t('hint.session-gone'));
    return router?.deliverToSession(hit.sessionId, text, message, chatKey);
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