import { deferredStateAccess, normalizeDeferredState } from './deferred-state.mjs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// dsh-im-multiagent extension (pointwise patch, plan section 2.3/8).
// Adds the mirror / messageIndex / mirroring / echoSet / snapshotMessageIds /
// menuSlugs state sections and their accessors on top of the vendored
// ConversationStateStore. The vendored sections (sessions, seenMessageIds,
// cursor, deferred) are untouched.
// ---------------------------------------------------------------------------

const EMPTY_MIRRORING = Object.freeze({ enabled: false, since: null });

function normalizeMirror(value) {
  const mirror = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [sessionId, entry] of Object.entries(value)) {
      if (typeof sessionId !== 'string' || !sessionId || !entry || typeof entry !== 'object') continue;
      const normalized = {
        name: typeof entry.name === 'string' ? entry.name : '',
        status: typeof entry.status === 'string' ? entry.status : 'cold',
        ...(isAlias(entry.alias) ? { alias: entry.alias } : {}),
        ...(typeof entry.workspace === 'string' ? { workspace: entry.workspace } : {}),
        ...(typeof entry.preset === 'string' ? { preset: entry.preset } : {}),
        ...(typeof entry.model === 'object' && entry.model !== null
          ? { model: { provider: String(entry.model.provider ?? ''), model: String(entry.model.model ?? '') } }
          : {}),
        ...(Number.isFinite(entry.lastActivityTs) ? { lastActivityTs: entry.lastActivityTs } : {}),
        ...(typeof entry.createdAt === 'string' ? { createdAt: entry.createdAt } : {}),
        ...(Number.isSafeInteger(entry.placeholderMessageId)
          ? { placeholderMessageId: entry.placeholderMessageId } : {}),
      };
      mirror[sessionId] = normalized;
    }
  }
  return mirror;
}

function normalizeMessageIndex(value) {
  const index = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [chatKey, entries] of Object.entries(value)) {
      if (typeof chatKey !== 'string' || !chatKey || !entries || typeof entries !== 'object') continue;
      const byMessageId = {};
      for (const [messageId, entry] of Object.entries(entries)) {
        if (typeof messageId !== 'string' || !messageId || !entry || typeof entry !== 'object') continue;
        if (typeof entry.sessionId !== 'string' || !entry.sessionId) continue;
        byMessageId[messageId] = {
          sessionId: entry.sessionId,
          direction: entry.direction === 'in' || entry.direction === 'out' ? entry.direction : 'out',
          ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
        };
      }
      index[chatKey] = byMessageId;
    }
  }
  return index;
}

function normalizeEchoSet(value) {
  const echoSet = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [rpcId, ts] of Object.entries(value)) {
      if (typeof rpcId === 'string' && rpcId && Number.isFinite(ts)) echoSet[rpcId] = ts;
    }
  }
  return echoSet;
}

/** Alias is a non-empty short handle ([a-z0-9_а-яё]+, see /alias). */
function isAlias(value) {
  return typeof value === 'string' && value.length > 0;
}

function normalizeMenuSlugs(value) {
  const slugs = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [slug, sessionId] of Object.entries(value)) {
      if (typeof slug === 'string' && slug && typeof sessionId === 'string' && sessionId) {
        slugs[slug] = sessionId;
      }
    }
  }
  return slugs;
}

const EMPTY_STATE = Object.freeze({
  version: 2,
  sessions: {},
  seenMessageIds: [],
  cursor: null,
  mirror: {},
  messageIndex: {},
  mirroring: EMPTY_MIRRORING,
  echoSet: {},
  snapshotMessageIds: [],
  menuSlugs: {},
});

function normalizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === 'string' && key && typeof sessionId === 'string' && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  const mirroring = value.mirroring && typeof value.mirroring === 'object'
    ? {
        enabled: value.mirroring.enabled === true,
        since: Number.isFinite(value.mirroring.since) ? value.mirroring.since : null,
      }
    : { ...EMPTY_MIRRORING };
  return {
    version: 2,
    sessions,
    ...(value.deferred ? { deferred: normalizeDeferredState(value.deferred) } : {}),
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => typeof id === 'string' && id).slice(-1_000)
      : [],
    cursor: Number.isSafeInteger(value.cursor) && value.cursor >= 0 ? value.cursor : null,
    mirror: normalizeMirror(value.mirror),
    messageIndex: normalizeMessageIndex(value.messageIndex),
    mirroring,
    echoSet: normalizeEchoSet(value.echoSet),
    snapshotMessageIds: Array.isArray(value.snapshotMessageIds)
      ? value.snapshotMessageIds.filter((id) => typeof id === 'string' && id).slice(-1_000)
      : [],
    menuSlugs: normalizeMenuSlugs(value.menuSlugs),
  };
}

export class ConversationStateStore {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();
  #deferred = deferredStateAccess(() => this.#state, () => this.#persist());

  constructor(path) {
    this.#path = path;
  }

  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  deferredEntries() { return this.#deferred.entries(); }
  putDeferred(entry) { return this.#deferred.put(entry); }
  patchDeferred(id, patch) { return this.#deferred.patch(id, patch); }
  removeDeferred(id) { return this.#deferred.remove(id); }

  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }

  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }

  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }

  async clearSessions() {
    this.#state.sessions = {};
    await this.#persist();
  }

  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }

  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1_000) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1_000);
    }
    await this.#persist();
  }

  cursor() {
    return this.#state.cursor;
  }

  async setCursor(cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Invalid update cursor');
    this.#state.cursor = cursor;
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  // --- dsh-im-multiagent extension: mirror ---------------------------------
  mirrorEntry(sessionId) {
    return this.#state.mirror[sessionId] ?? null;
  }

  async setMirrorEntry(sessionId, patch) {
    const current = this.#state.mirror[sessionId] ?? {};
    // A null alias removes the key (the /alias reset); other keys merge
    // verbatim, including the placeholderMessageId null sentinel.
    const next = { ...current, ...patch };
    if (Object.hasOwn(patch, 'alias') && patch.alias === null) delete next.alias;
    this.#state.mirror[sessionId] = next;
    await this.#persist();
  }

  async deleteMirrorEntry(sessionId) {
    if (!Object.hasOwn(this.#state.mirror, sessionId)) return;
    delete this.#state.mirror[sessionId];
    await this.#persist();
  }

  mirrorEntries() {
    return structuredClone(this.#state.mirror);
  }

  // --- dsh-im-multiagent extension: message index --------------------------
  indexLookup(chatKey, messageId) {
    return this.#state.messageIndex[chatKey]?.[messageId] ?? null;
  }

  async indexPut(chatKey, entry) {
    const byMessageId = this.#state.messageIndex[chatKey] ??= {};
    byMessageId[entry.messageId] = {
      sessionId: entry.sessionId,
      direction: entry.direction === 'in' ? 'in' : 'out',
      ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
    };
    await this.#persist();
  }

  async indexPrune(chatKey, { limit = 1_000, ttlMs = 30 * 24 * 60 * 60 * 1_000 } = {}) {
    const byMessageId = this.#state.messageIndex[chatKey];
    if (!byMessageId) return 0;
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [messageId, entry] of Object.entries(byMessageId)) {
      if (entry.ts < cutoff) {
        delete byMessageId[messageId];
        removed += 1;
      }
    }
    const ids = Object.keys(byMessageId);
    if (ids.length > limit) {
      ids.sort((left, right) => byMessageId[left].ts - byMessageId[right].ts);
      for (const messageId of ids.slice(0, ids.length - limit)) {
        delete byMessageId[messageId];
        removed += 1;
      }
    }
    if (removed > 0) await this.#persist();
    return removed;
  }

  indexStats() {
    const stats = {};
    for (const [chatKey, byMessageId] of Object.entries(this.#state.messageIndex)) {
      stats[chatKey] = Object.keys(byMessageId).length;
    }
    return stats;
  }

  // --- dsh-im-multiagent extension: mirroring toggle -----------------------
  mirroring() {
    return structuredClone(this.#state.mirroring);
  }

  async setMirroring(enabled) {
    this.#state.mirroring = {
      enabled: enabled === true,
      since: enabled === true ? (this.#state.mirroring.since ?? Date.now()) : null,
    };
    await this.#persist();
  }

  // --- dsh-im-multiagent extension: echo set (TTL 30 days) -----------------
  echoHas(rpcId) {
    return typeof rpcId === 'string' && rpcId && Object.hasOwn(this.#state.echoSet, rpcId);
  }

  async echoAdd(rpcId) {
    if (typeof rpcId !== 'string' || !rpcId) return;
    this.#state.echoSet[rpcId] = Date.now();
    await this.#persist();
  }

  async echoPrune(ttlMs = 30 * 24 * 60 * 60 * 1_000) {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [rpcId, ts] of Object.entries(this.#state.echoSet)) {
      if (ts < cutoff) {
        delete this.#state.echoSet[rpcId];
        removed += 1;
      }
    }
    if (removed > 0) await this.#persist();
    return removed;
  }

  // --- dsh-im-multiagent extension: snapshot message ids -------------------
  snapshotIds() {
    return [...this.#state.snapshotMessageIds];
  }

  async setSnapshotIds(ids) {
    this.#state.snapshotMessageIds = Array.isArray(ids)
      ? ids.filter((id) => typeof id === 'string' && id).slice(-1_000)
      : [];
    await this.#persist();
  }

  // --- dsh-im-multiagent extension: menu slugs -----------------------------
  menuSlugFor(slug) {
    return this.#state.menuSlugs[slug] ?? null;
  }

  async setMenuSlug(slug, sessionId) {
    if (typeof slug !== 'string' || !slug || typeof sessionId !== 'string' || !sessionId) return;
    this.#state.menuSlugs[slug] = sessionId;
    await this.#persist();
  }

  async deleteMenuSlug(slug) {
    if (!Object.hasOwn(this.#state.menuSlugs, slug)) return;
    delete this.#state.menuSlugs[slug];
    await this.#persist();
  }

  menuSlugsAll() {
    return structuredClone(this.#state.menuSlugs);
  }

  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#state = structuredClone(EMPTY_STATE);
  }

  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
