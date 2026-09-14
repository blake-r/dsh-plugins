// dsh-im-multiagent MenuBuilder (plan section 4.2, stage 6a).
//
// The Telegram command menu as an addressing mechanism. Two levels:
//   1. Bot-level static menu (set at startup): the plugin's own commands.
//   2. Per-chat dynamic menu (setMyCommands with scope): static commands +
//      a session section (top-N by last activity, including cold sessions)
//      + workspace drill-downs (/w_<slug>) + preset drill-downs (/p_<slug>).
//
// Slugification: slug = slugify(alias ?? name); lowercase [a-z0-9_], <=32;
// dedupe with _2/_3; collisions with static commands and the w_/p_ drill-down
// namespace get a suffix; Cyrillic/invalid titles fall back to s_<N> (N = the
// stable /as ordinal). Session slugs live in state.menuSlugs (slug -> sessionId)
// and are refreshed on session/title and /alias (the alias survives auto-titles).
//
// Updates are debounced (2-5 s), diffed against the last sent list, and
// serialized through a queue with 429 backoff. Errors are non-fatal: log and
// retry on the next change.

import { sortedSessions } from './session-list.mjs';

const STATIC_COMMANDS = Object.freeze([
  'new', 'as', 'ws', 'ps', 'hs', 'follow', 'unfollow',
  'stop', 'steer', 'enqueue', 'to', 'help',
]);

const SLUG_RE = /^[a-z0-9_]{1,32}$/;
const CYRILLIC_RE = /[а-яё]/i;

const DEBOUNCE_MS = 2_000;
const MAX_COMMANDS = 100;
const RETRY_AFTER_MS = 5_000;
const SLUG_BASE_MAX = 30; // room for the _2/_3 dedupe suffix

/** Stable identity of a composed command list (for the diff). */
function listFingerprint(commands) {
  return commands.map((item) => `${item.command}\u0000${item.description}`).join('\u0001');
}

export class MenuBuilder {
  #state;
  #mirror;
  #i18n;
  #config;
  #client;
  #workspaceRegistry;
  #presets;
  #logger;
  #timer = null;
  #queue = Promise.resolve();
  #lastSent = new Map(); // chatKey -> fingerprint string

  constructor({ state, mirror, i18n, config = {}, client, workspaceRegistry, presets, logger = console }) {
    this.#state = state;
    this.#mirror = mirror;
    this.#i18n = i18n;
    this.#config = config;
    this.#client = client;
    this.#workspaceRegistry = workspaceRegistry;
    this.#presets = presets;
    this.#logger = logger;
  }

  // --- public API -----------------------------------------------------------

  /** Set the bot-level static menu (startup). */
  async start() {
    const commands = this.#staticCommands();
    await this.#enqueue(async () => {
      try {
        if (commands.length > 0) {
          await this.#client?.setMyCommands({ commands });
        } else {
          await this.#client?.deleteMyCommands();
        }
      } catch (error) {
        this.#logger.warn?.('[dsh-im-multiagent] bot menu setup failed:', error);
      }
    });
  }

  /** Debounced refresh of every known chat's menu. */
  scheduleUpdate() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.updateNow();
    }, DEBOUNCE_MS);
  }

  /** Recompute session slugs and schedule a menu refresh (title/alias/roster). */
  async onSessionsChanged() {
    await this.#refreshSlugs();
    this.scheduleUpdate();
  }

  /** Refresh every known chat's menu immediately (used by tests). */
  async updateNow() {
    for (const chatKey of this.#knownChats()) {
      const commands = await this.#composeChatMenu(chatKey);
      const fingerprint = listFingerprint(commands);
      if (this.#lastSent.get(chatKey) === fingerprint) continue;
      this.#lastSent.set(chatKey, fingerprint);
      await this.#enqueue(async () => {
        try {
          await this.#client?.setMyCommands({
            commands,
            scope: { type: 'chat', chat_id: this.#chatId(chatKey) },
          });
        } catch (error) {
          this.#logger.warn?.('[dsh-im-multiagent] per-chat menu update failed:', error);
          // 429 backoff: the next change retries; the stale fingerprint keeps
          // the failed list from being re-sent unchanged.
          await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
        }
      });
    }
  }

  dispose() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  // --- composition ----------------------------------------------------------

  #staticCommands() {
    return STATIC_COMMANDS.map((name) => ({
      command: name,
      description: this.#i18n.t(`menu.${name}`),
    }));
  }

  /** Chats that have interacted with the bot (message index keys). */
  #knownChats() {
    const stats = this.#state.indexStats?.() ?? {};
    return Object.keys(stats);
  }

  #chatId(chatKey) {
    const id = Number(String(chatKey).split(':')[1]);
    return Number.isSafeInteger(id) ? id : null;
  }

  /**
   * Compose the per-chat command list: static commands, then the session
   * section (top-N by last activity, including cold), then workspace and
   * preset drill-downs. Priority when over the 100-command cap: static ->
   * sessions -> workspaces -> presets (full lists stay in /ws and /ps).
   */
  async #composeChatMenu(chatKey) {
    void chatKey;
    const commands = this.#staticCommands();
    const taken = new Set(commands.map((item) => item.command));
    const sessionCap = Number(this.#config.menu?.sessionCap ?? 10);
    const slugBySession = this.#state.menuSlugsAll();

    const sessions = sortedSessions(this.#mirror.sessions())
      .sort((left, right) => {
        const a = left.entry?.lastActivityTs ?? 0;
        const b = right.entry?.lastActivityTs ?? 0;
        return b - a;
      })
      .slice(0, sessionCap);

    for (const { sessionId, entry } of sessions) {
      const slug = this.#slugFor(sessionId, entry, taken, slugBySession);
      if (!slug) continue;
      taken.add(slug);
      commands.push({
        command: slug,
        description: this.#displayName(sessionId, entry),
      });
    }

    if (this.#config.menu?.workspaces !== false) {
      for (const workspace of this.#workspaceList()) {
        const slug = this.#drilldownSlug('w', workspace.title, taken);
        if (!slug) continue;
        taken.add(slug);
        commands.push({
          command: slug,
          description: this.#i18n.t('menu.ws-section'),
        });
      }
    }

    if (this.#config.menu?.presets !== false) {
      for (const preset of await this.#presetList()) {
        const slug = this.#drilldownSlug('p', preset.name, taken);
        if (!slug) continue;
        taken.add(slug);
        commands.push({
          command: slug,
          description: this.#i18n.t('menu.ps-section'),
        });
      }
    }

    return commands.slice(0, MAX_COMMANDS);
  }

  // --- slugs ----------------------------------------------------------------

  /**
   * Session slug: slugify(alias ?? name); Cyrillic/invalid -> s_<N> (N = the
   * stable /as ordinal). Reserved names (static commands, w_/p_ drill-downs)
   * and duplicates get a _2/_3 suffix.
   */
  #slugFor(sessionId, entry, taken, slugBySession) {
    const base = String(entry?.alias ?? entry?.name ?? '').trim().toLowerCase();
    const ordinal = this.#ordinalOf(sessionId);
    let slug;
    if (!base || CYRILLIC_RE.test(base) || !SLUG_RE.test(base)) {
      slug = `s_${ordinal}`;
    } else {
      slug = base.slice(0, SLUG_BASE_MAX);
    }
    return this.#dedupe(slug, taken, slugBySession, sessionId);
  }

  /** Workspace/preset drill-down slug: /w_<slug> / /p_<slug>. */
  #drilldownSlug(prefix, title, taken) {
    const base = String(title ?? '').trim().toLowerCase();
    if (!base || CYRILLIC_RE.test(base) || !SLUG_RE.test(base)) return null;
    return this.#dedupe(`${prefix}_${base.slice(0, SLUG_BASE_MAX)}`, taken, null, null);
  }

  #dedupe(slug, taken, slugBySession, sessionId) {
    if (!taken.has(slug)) return slug;
    let candidate;
    let n = 2;
    do {
      candidate = `${slug}_${n}`;
      n += 1;
      if (candidate.length > 32) return null; // exhausted the suffix space
    } while (taken.has(candidate) || (slugBySession && slugBySession[candidate] && slugBySession[candidate] !== sessionId));
    return candidate;
  }

  /** Stable /as ordinal (1-based) for the s_<N> fallback. */
  #ordinalOf(sessionId) {
    const sessions = sortedSessions(this.#mirror.sessions());
    const index = sessions.findIndex(({ sessionId: id }) => id === sessionId);
    return index >= 0 ? index + 1 : 1;
  }

  /**
   * Recompute every session slug from the current roster and persist the
   * mapping. Stale slugs (sessions that disappeared or renamed) are dropped.
   */
  async #refreshSlugs() {
    const sessions = sortedSessions(this.#mirror.sessions());
    const taken = new Set(STATIC_COMMANDS);
    const slugBySession = this.#state.menuSlugsAll();
    const next = new Map(); // sessionId -> slug
    for (const { sessionId, entry } of sessions) {
      const slug = this.#slugFor(sessionId, entry, taken, slugBySession);
      if (!slug) continue;
      taken.add(slug);
      next.set(sessionId, slug);
    }
    for (const [sessionId, slug] of next) {
      if (slugBySession[slug] !== sessionId) {
        await this.#state.setMenuSlug(slug, sessionId);
      }
    }
    for (const [slug, sessionId] of Object.entries(slugBySession)) {
      if (next.get(sessionId) !== slug) {
        await this.#state.deleteMenuSlug(slug);
      }
    }
  }

  // --- services -------------------------------------------------------------

  #displayName(sessionId, entry) {
    return entry?.name ?? sessionId;
  }

  #workspaceList() {
    try {
      const workspaces = this.#workspaceRegistry?.list?.() ?? [];
      return Array.isArray(workspaces) ? workspaces : [];
    } catch {
      return [];
    }
  }

  async #presetList() {
    try {
      const presets = await this.#presets?.list?.() ?? [];
      return Array.isArray(presets) ? presets : [];
    } catch {
      return [];
    }
  }

  // --- queue ----------------------------------------------------------------

  /** Serialized setMyCommands calls; 429 backoff handled by the caller. */
  #enqueue(operation) {
    const run = this.#queue.then(operation);
    this.#queue = run.catch(() => {});
    return run;
  }
}