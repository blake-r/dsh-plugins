// dsh-im-multiagent SessionMirror (plan section 5.2 / 6.1 / 6.3 / 6.4).
//
// Sole owner of the session roster. Discovers sessions at startup
// (sessionQuery.listSessions + ctx.agents.list) and keeps the roster current
// via agent/created / agent/disposed (global). Mirrors every relevant
// session/event (global) into the Telegram chat through the outbound channel:
//   - user/message (source.kind === 'user', not our own echo rpcId) -> text;
//   - turn/start -> placeholder "⏳ <name>: thinking…";
//   - tool/call -> placeholder edited to "🔧 <tool>";
//   - assistant/message -> accumulated per turn (AssistantTextAccumulator);
//   - turn/end (reason.kind === 'completed') -> placeholder edited to the
//     final text (or deleted + parts for long finals); other reasons ->
//     "⏹ interrupted/error";
//   - approval/asked|decided, compaction/* -> placeholder status updates;
//   - session/title -> mirror entry name.
//
// Every outbound message is recorded in the MessageIndex (message_id ->
// sessionId), so reply routing works on status placeholders and finals alike.
// Echo protection: user messages whose source.rpcId is in the persistent echo
// set (populated by InboundRouter on injection) are skipped.
//
// The outbound contract is implemented by BotChannel (stage 5):
//   sendText(text) -> { messageId }
//   sendParts(text) -> [messageId, ...]
//   editText(messageId, text)
//   deleteMessage(messageId)

import { AssistantTextAccumulator, textFromHarnessContent } from '../../src/channels/shared/harness-client.mjs';

export const MIRROR_STATUS = Object.freeze({
  COLD: 'cold',
  WORKING: 'working',
  IDLE: 'idle',
  AWAITING_APPROVAL: 'awaiting-approval',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
  CLOSED: 'closed',
  RESTARTED: 'restarted',
  NO_TEXT: 'no-text',
});

// mirror status -> i18n catalog key (section 6.9 status.*).
const STATUS_I18N_KEY = Object.freeze({
  [MIRROR_STATUS.COLD]: 'status.cold',
  [MIRROR_STATUS.WORKING]: 'status.thinking',
  [MIRROR_STATUS.IDLE]: 'status.waiting',
  [MIRROR_STATUS.AWAITING_APPROVAL]: 'status.awaiting-approval',
  [MIRROR_STATUS.INTERRUPTED]: 'status.interrupted',
  [MIRROR_STATUS.ERROR]: 'status.error',
  [MIRROR_STATUS.CLOSED]: 'status.closed',
  [MIRROR_STATUS.RESTARTED]: 'status.restarted',
});

const DEFAULT_MAX_FINAL_TEXT_LENGTH = 3_800;

export class SessionMirror {
  #state;        // extended ConversationStateStore
  #index;        // MessageIndex
  #i18n;         // createI18n() result
  #outbound;     // BotChannel contract (stage 5)
  #chatKey;      // chat identity, e.g. "direct:12345"
  #sessionQuery; // ctx.sessionQuery
  #agents;       // ctx.agents
  #config;       // { maxFinalTextLength }
  #turns = new Map();   // sessionId -> turn state
  #disposed = new Set();
  #started = false;

  constructor({ state, index, i18n, outbound, chatKey, sessionQuery, agents, config = {} }) {
    this.#state = state;
    this.#index = index;
    this.#i18n = i18n;
    this.#outbound = outbound;
    this.#chatKey = chatKey;
    this.#sessionQuery = sessionQuery;
    this.#agents = agents;
    this.#config = {
      maxFinalTextLength: Number.isFinite(config.maxFinalTextLength)
        ? config.maxFinalTextLength
        : DEFAULT_MAX_FINAL_TEXT_LENGTH,
    };
  }

  /** Subscribe to global events and run initial discovery. */
  async start() {
    if (this.#started) return;
    this.#started = true;
    await this.#recoverInterrupted();
    await this.discover();
  }

  async stop() {
    this.#started = false;
  }

  /**
   * Current roster: sessionId -> mirror metadata (name, status, workspace,
   * preset, lastActivityTs, ...). The router uses this for rule 4 (a lone
   * session is the unambiguous recipient) and for /to-style addressing.
   */
  sessions() {
    return this.#state.mirrorEntries();
  }

  // --- discovery -----------------------------------------------------------

  /** Snapshot the roster: persisted + live sessions, then live agents. */
  async discover() {
    const records = await this.#sessionQuery.listSessions();
    for (const { header, live } of records) {
      await this.#upsertSession(header.id, {
        live,
        createdAt: header.createdAt,
        workspace: header.cwd,
        preset: header.agentPreset,
      });
    }
    for (const agent of this.#agents.list()) {
      await this.#upsertSession(agent.session.id, { live: true });
    }
  }

  async #upsertSession(sessionId, meta) {
    const existing = this.#state.mirrorEntry(sessionId);
    if (existing) {
      const patch = {};
      if (meta.workspace && !existing.workspace) patch.workspace = meta.workspace;
      if (meta.preset && !existing.preset) patch.preset = meta.preset;
      if (meta.live && (existing.status === MIRROR_STATUS.COLD || existing.status === MIRROR_STATUS.CLOSED)) {
        patch.status = MIRROR_STATUS.IDLE;
      }
      if (Object.keys(patch).length > 0) await this.#state.setMirrorEntry(sessionId, patch);
      return;
    }
    await this.#state.setMirrorEntry(sessionId, {
      name: sessionId,
      status: meta.live ? MIRROR_STATUS.IDLE : MIRROR_STATUS.COLD,
      ...(meta.workspace ? { workspace: meta.workspace } : {}),
      ...(meta.preset ? { preset: meta.preset } : {}),
      ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
      lastActivityTs: Date.now(),
    });
  }

  // --- restart recovery (Q23) ----------------------------------------------

  /** Sessions left "working" by a restart get a "interrupted by restart" status. */
  async #recoverInterrupted() {
    for (const [sessionId, entry] of Object.entries(this.#state.mirrorEntries())) {
      if (entry.status === MIRROR_STATUS.WORKING || entry.status === MIRROR_STATUS.AWAITING_APPROVAL) {
        if (entry.placeholderMessageId != null) {
          await this.#outbound.editText(entry.placeholderMessageId, this.#i18n.t('status.restarted'));
        }
        await this.#state.setMirrorEntry(sessionId, { status: MIRROR_STATUS.RESTARTED });
      }
    }
  }

  // --- agent lifecycle -----------------------------------------------------

  async onAgentCreated({ agent }) {
    this.#disposed.delete(agent.session.id);
    await this.#upsertSession(agent.session.id, { live: true });
  }

  async onAgentDisposed({ agent }) {
    const sessionId = agent.session.id;
    this.#disposed.add(sessionId);
    const entry = this.#state.mirrorEntry(sessionId);
    if (entry?.placeholderMessageId != null) {
      await this.#outbound.editText(entry.placeholderMessageId, this.#i18n.t('status.closed'));
    }
    await this.#state.setMirrorEntry(sessionId, { status: MIRROR_STATUS.CLOSED });
    this.#turns.delete(sessionId);
  }

  // --- session/event handling ----------------------------------------------

  async onSessionEvent(session, event) {
    if (!this.#started) return;
    const sessionId = session.id;
    if (this.#disposed.has(sessionId)) return;
    const entry = await this.#ensureEntry(sessionId);
    await this.#state.setMirrorEntry(sessionId, { lastActivityTs: Date.now() });
    switch (event.type) {
      case 'user/message': return this.#onUserMessage(sessionId, event);
      case 'turn/start': return this.#onTurnStart(sessionId, event);
      case 'tool/call': return this.#onToolCall(sessionId, event);
      case 'assistant/attempt': return this.#onAssistantAttempt(sessionId, event);
      case 'assistant/message': return this.#onAssistantMessage(sessionId, event);
      case 'turn/end': return this.#onTurnEnd(sessionId, event);
      case 'approval/asked': return this.#onApprovalAsked(sessionId, event);
      case 'approval/decided': return this.#onApprovalDecided(sessionId, event);
      case 'session/title': return this.#onSessionTitle(sessionId, event);
      case 'compaction/start':
      case 'compaction/end':
        return this.#onCompaction(sessionId, event);
      default:
        return;
    }
  }

  async #ensureEntry(sessionId) {
    const entry = this.#state.mirrorEntry(sessionId);
    if (entry) return entry;
    await this.#state.setMirrorEntry(sessionId, {
      name: sessionId,
      status: MIRROR_STATUS.IDLE,
      lastActivityTs: Date.now(),
    });
    return this.#state.mirrorEntry(sessionId);
  }

  // --- event handlers ------------------------------------------------------

  async #onUserMessage(sessionId, event) {
    const source = event.data?.source ?? {};
    if (source.kind !== 'user') return;
    if (typeof source.rpcId === 'string' && source.rpcId && this.#state.echoHas(source.rpcId)) return;
    const text = textFromHarnessContent(event.data?.message?.content);
    if (!text) return;
    const { messageId } = await this.#outbound.sendText(text);
    await this.#index.put(this.#chatKey, { messageId, sessionId, direction: 'out' });
  }

  async #onTurnStart(sessionId, event) {
    const turn = this.#turns.get(sessionId) ?? this.#newTurn(sessionId);
    turn.turn = event.data?.turn ?? turn.turn;
    turn.status = MIRROR_STATUS.WORKING;
    await this.#updateStatus(sessionId, turn);
  }

  async #onToolCall(sessionId, event) {
    const turn = this.#turns.get(sessionId);
    if (!turn || turn.status !== MIRROR_STATUS.WORKING) return;
    turn.lastToolName = typeof event.data?.name === 'string' && event.data.name
      ? event.data.name
      : 'tool';
    await this.#updateStatus(sessionId, turn);
  }

  async #onAssistantAttempt(sessionId, event) {
    const turn = this.#turns.get(sessionId) ?? this.#newTurn(sessionId);
    if (turn.status !== MIRROR_STATUS.WORKING) {
      turn.status = MIRROR_STATUS.WORKING;
      await this.#updateStatus(sessionId, turn);
    }
  }

  async #onAssistantMessage(sessionId, event) {
    const turn = this.#turns.get(sessionId);
    if (!turn) return;
    const text = textFromHarnessContent(event.data?.message?.content);
    if (text) turn.accumulator.setCanonical(event.data?.step, text);
    const source = event.data?.message?.source;
    if (source && (source.provider || source.model)) {
      await this.#state.setMirrorEntry(sessionId, {
        model: { provider: String(source.provider ?? ''), model: String(source.model ?? '') },
      });
    }
  }

  async #onTurnEnd(sessionId, event) {
    const turn = this.#turns.get(sessionId);
    if (!turn) return;
    const reason = event.data?.reason?.kind;
    const finalText = turn.accumulator.text;
    const entry = this.#state.mirrorEntry(sessionId);
    if (reason === 'completed') {
      if (finalText) {
        if (finalText.length > this.#config.maxFinalTextLength) {
          if (entry?.placeholderMessageId != null) {
            await this.#outbound.deleteMessage(entry.placeholderMessageId);
          }
          const messageIds = await this.#outbound.sendParts(finalText);
          for (const messageId of messageIds) {
            await this.#index.put(this.#chatKey, { messageId, sessionId, direction: 'out' });
          }
          await this.#state.setMirrorEntry(sessionId, { placeholderMessageId: null, status: MIRROR_STATUS.IDLE });
        } else if (entry?.placeholderMessageId != null) {
          await this.#outbound.editText(entry.placeholderMessageId, finalText);
          await this.#state.setMirrorEntry(sessionId, { status: MIRROR_STATUS.IDLE });
        } else {
          const { messageId } = await this.#outbound.sendText(finalText);
          await this.#index.put(this.#chatKey, { messageId, sessionId, direction: 'out' });
          await this.#state.setMirrorEntry(sessionId, { status: MIRROR_STATUS.IDLE });
        }
      } else {
        await this.#updateStatus(sessionId, turn, MIRROR_STATUS.NO_TEXT);
        await this.#state.setMirrorEntry(sessionId, { status: MIRROR_STATUS.IDLE });
      }
    } else {
      const status = reason === 'interrupted' ? MIRROR_STATUS.INTERRUPTED : MIRROR_STATUS.ERROR;
      await this.#updateStatus(sessionId, turn, status);
      await this.#state.setMirrorEntry(sessionId, { status });
    }
    this.#turns.delete(sessionId);
  }

  async #onApprovalAsked(sessionId, event) {
    const turn = this.#turns.get(sessionId);
    if (!turn) return;
    turn.awaitingApproval = true;
    await this.#updateStatus(sessionId, turn);
  }

  async #onApprovalDecided(sessionId, event) {
    const turn = this.#turns.get(sessionId);
    if (!turn) return;
    turn.awaitingApproval = false;
    await this.#updateStatus(sessionId, turn);
  }

  async #onSessionTitle(sessionId, event) {
    const title = event.data?.title;
    if (typeof title === 'string' && title) {
      await this.#state.setMirrorEntry(sessionId, { name: title });
    }
  }

  async #onCompaction(sessionId, event) {
    const turn = this.#turns.get(sessionId);
    if (!turn) return;
    if (event.type === 'compaction/start') {
      await this.#updateStatus(sessionId, turn);
    }
  }

  // --- status plumbing -----------------------------------------------------

  #newTurn(sessionId) {
    const turn = {
      turn: null,
      status: MIRROR_STATUS.IDLE,
      accumulator: new AssistantTextAccumulator(),
      lastToolName: null,
      awaitingApproval: false,
    };
    this.#turns.set(sessionId, turn);
    return turn;
  }

  /** Status text for a turn; live statuses derive from the turn state. */
  #statusText(sessionId, turn, status) {
    const entry = this.#state.mirrorEntry(sessionId);
    const name = entry?.name || sessionId;
    switch (status) {
      case MIRROR_STATUS.INTERRUPTED:
        return this.#i18n.t('status.interrupted');
      case MIRROR_STATUS.ERROR:
        return this.#i18n.t('status.error');
      case MIRROR_STATUS.NO_TEXT:
        return this.#i18n.t('status.no-text');
      case MIRROR_STATUS.RESTARTED:
        return this.#i18n.t('status.restarted');
      case MIRROR_STATUS.CLOSED:
        return this.#i18n.t('status.closed');
      default:
        if (turn.awaitingApproval) return this.#i18n.t('status.awaiting-approval');
        if (turn.lastToolName) return this.#i18n.t('status.tool', { tool: turn.lastToolName });
        return this.#i18n.t('status.placeholder', { name });
    }
  }

  /**
   * Ensure a placeholder message exists for the session and edit it to the
   * current status text. The placeholder is a real message: it is indexed so
   * reply routing works on it.
   */
  async #updateStatus(sessionId, turn, status = turn.status) {
    const entry = this.#state.mirrorEntry(sessionId);
    const text = this.#statusText(sessionId, turn, status);
    if (entry?.placeholderMessageId == null) {
      const { messageId } = await this.#outbound.sendText(text);
      await this.#index.put(this.#chatKey, { messageId, sessionId, direction: 'out' });
      await this.#state.setMirrorEntry(sessionId, { placeholderMessageId: messageId, status });
    } else {
      await this.#outbound.editText(entry.placeholderMessageId, text);
      await this.#state.setMirrorEntry(sessionId, { status });
    }
  }

  // --- roster access (used by /as, snapshot, MenuBuilder, RPC) -------------

  mirrorEntries() {
    return this.#state.mirrorEntries();
  }

  mirrorEntry(sessionId) {
    return this.#state.mirrorEntry(sessionId);
  }

  /** Remember an injected rpcId so its user/message echo is skipped. */
  async rememberEcho(rpcId) {
    await this.#state.echoAdd(rpcId);
  }
}

// Re-export for tests and callers that need the status vocabulary.
export { MIRROR_STATUS as STATUS };