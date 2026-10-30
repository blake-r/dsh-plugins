// dsh-im-multiagent MessageIndex (plan section 3).
//
// Pure routing table: Telegram message_id -> sessionId, per chat. Written on
// every accepted message in both directions:
//   - a user message -> the session it was delivered to (reply on the user's
//     own message continues the same session);
//   - a session message (mirror) -> the session that produced it (reply on an
//     agent message returns to its session).
//
// Only single-session messages are indexed (finals / statuses / interactions /
// snapshot / /hs output). Command output and pickers are not indexed; pending
// pickers live in the router's in-memory registry (plan section 4, Q25/Q32).

export const INDEX_DEFAULT_LIMIT = 1_000;
export const INDEX_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export class MessageIndex {
  #state;

  /**
   * @param {object} state - the extended ConversationStateStore.
   */
  constructor(state) {
    this.#state = state;
  }

  /**
   * Resolve the session that owns a Telegram message in a chat.
   * @param {string} chatKey - chat identity (e.g. "direct:12345").
   * @param {string|number} messageId - Telegram message_id.
   * @returns {{ sessionId: string, direction: 'in'|'out', ts: number } | null}
   */
  lookup(chatKey, messageId) {
    if (typeof messageId !== 'string') messageId = String(messageId);
    return this.#state.indexLookup(chatKey, messageId);
  }

  /**
   * Record one message ownership.
   * @param {string} chatKey
   * @param {{ messageId: string|number, sessionId: string, direction: 'in'|'out', ts?: number }} entry
   */
  async put(chatKey, entry) {
    await this.#state.indexPut(chatKey, {
      messageId: String(entry.messageId),
      sessionId: entry.sessionId,
      direction: entry.direction,
      ts: entry.ts ?? Date.now(),
    });
  }

  /**
   * Drop expired and overflow entries for one chat.
   * @returns {Promise<number>} number of removed entries.
   */
  async prune(chatKey, { limit = INDEX_DEFAULT_LIMIT, ttlMs = INDEX_DEFAULT_TTL_MS } = {}) {
    return this.#state.indexPrune(chatKey, { limit, ttlMs });
  }

  /** Per-chat entry counts (diagnostics / RPC). */
  stats() {
    return this.#state.indexStats();
  }
}