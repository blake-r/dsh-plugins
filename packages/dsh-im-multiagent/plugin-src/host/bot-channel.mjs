// dsh-im-multiagent BotChannel (plan sections 5.2, 6.3, 7; stage 5).
//
// One outbound queue per chat. Every Telegram call is serialized (a single
// in-flight HTTP operation), and the channel enforces the delivery
// constraints the mirror/router rely on:
//
//   - sendMessage rate gate (~1 msg/s per chat, section 6.3 / Q21);
//   - editMessageText throttle per message (~1/3 s, at most editBurstMax
//     edits per rolling window, latest text wins — section 6.3 / Q21);
//   - no-op comparison before an edit (Q22): identical text is a no-op;
//   - 429 backoff with Telegram's retry_after (Q21);
//   - edit failure falls back to a fresh sendMessage and reports the new
//     message id so callers can re-index (Q22);
//   - text split at the 4000-UTF-16-unit boundary (sendText/sendParts);
//   - deferred delivery: per-session "deferred" rows in the state store,
//     delivered (or re-scheduled) through the same queue (section 7).
//
// The channel presents two call shapes over the same queue:
//
//   mirror contract (SessionMirror, bound chat):
//     sendText(text) -> { messageId }
//     sendParts(text) -> [messageId, ...]
//     editText(messageId, text) -> { messageId }   // may change (Q22)
//     deleteMessage(messageId)
//
//   client shape (InboundRouter / InteractionAdapter, explicit target):
//     sendTo(target, text, { replyMarkup }) -> { providerMessageIds }
//     editTargetText(target, messageId, text) -> { messageId }
//     deleteTargetMessage(target, messageId)
//     answerCallback(callbackQueryId, { text })
//     editMessageReplyMarkup(target, { replyMarkup })
//
// The producer (TelegramRuntime/TelegramBotClient) must expose sendText,
// editText, deleteMessage, answerCallbackQuery and editMessageReplyMarkup;
// the stage-5 patch adds editText/deleteMessage to the vendored client.

import { splitTelegramRegularText } from '../../src/channels/telegram/telegram-rich-message.mjs';

const DEFAULT_SEND_INTERVAL_MS = 1_050;
const DEFAULT_EDIT_INTERVAL_MS = 350;
const DEFAULT_EDIT_BURST_MAX = 19;
const DEFAULT_EDIT_BURST_WINDOW_MS = 60_000;
const DEFAULT_RETRY_429_MAX = 3;
const DEFAULT_RETRY_429_DELAY_MS = 1_000;
const DEFAULT_RETRY_429_CAP_MS = 30_000;
const DEFAULT_DEFER_POLL_MS = 30_000;

function isRateLimitError(error) {
  return error && (Number(error.providerCode) === 429 || Number(error.status) === 429);
}

function retryAfterMs(error, fallback) {
  const value = Number(error?.retryAfter ?? error?.retry_after);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class BotChannel {
  #client;    // TelegramBotClient (vendored, stage-5 patched)
  #target;    // bound chat: { chatId, messageThreadId? }
  #chatKey;   // chat identity, e.g. "direct:12345" (deferred rows key)
  #state;     // optional extended ConversationStateStore
  #config;
  #logger;
  #now;
  #sleep;

  #tail = Promise.resolve();          // global serialization
  #inFlight = 0;
  #nextSendAt = 0;                    // next allowed sendMessage wall time
  #editQueues = new Map();            // messageId -> [{ text, resolve, reject }]
  #drainers = new Set();              // messageId currently being drained
  #nextEditAt = new Map();            // messageId -> earliest allowed edit
  #editStamps = new Map();            // messageId -> [ts, ...] applied edits
  #lastText = new Map();              // messageId -> last applied text (no-op)
  #timers = new Map();                // deferred id -> timer
  #started = false;
  #stopped = false;

  constructor({ client, target, chatKey, state, config = {}, logger = console }) {
    if (!client || !target) {
      throw new TypeError('BotChannel requires a Telegram client and a chat target');
    }
    if (!Number.isSafeInteger(target?.chatId) && typeof target?.chatId !== 'string') {
      throw new TypeError('BotChannel chat target requires a chatId');
    }
    this.#client = client;
    this.#target = target;
    this.#chatKey = typeof chatKey === 'string' && chatKey ? chatKey : String(target.chatId);
    this.#state = state;
    this.#logger = logger;
    this.#now = typeof config.now === 'function' ? config.now : Date.now;
    this.#sleep = typeof config.sleep === 'function' ? config.sleep : sleepMs;
    this.#config = {
      sendIntervalMs: positive(config.sendIntervalMs, DEFAULT_SEND_INTERVAL_MS),
      editIntervalMs: positive(config.editIntervalMs, DEFAULT_EDIT_INTERVAL_MS),
      editBurstMax: positive(config.editBurstMax, DEFAULT_EDIT_BURST_MAX),
      editBurstWindowMs: positive(config.editBurstWindowMs, DEFAULT_EDIT_BURST_WINDOW_MS),
      retry429Max: positive(config.retry429Max, DEFAULT_RETRY_429_MAX),
      retry429DelayMs: positive(config.retry429DelayMs, DEFAULT_RETRY_429_DELAY_MS),
      retry429CapMs: positive(config.retry429CapMs, DEFAULT_RETRY_429_CAP_MS),
      deferPollMs: positive(config.deferPollMs, DEFAULT_DEFER_POLL_MS),
    };
  }

  get status() {
    return {
      chatKey: this.#chatKey,
      inFlight: this.#inFlight,
      pendingEdits: [...this.#editQueues.entries()].map(([messageId, queue]) => ({
        messageId,
        pending: queue.length,
      })),
      deferred: this.#state?.deferredEntries
        ? this.#state.deferredEntries().filter((entry) => entry.key === this.#chatKey).length
        : this.#timers.size,
    };
  }

  /** Reschedule durable deferred rows for this chat (restart recovery). */
  async start() {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    if (!this.#state) return;
    const now = this.#now();
    for (const entry of this.#state.deferredEntries()) {
      if (entry.key !== this.#chatKey || entry.status !== 'pending') continue;
      this.#scheduleDeferred(entry, Math.max(entry.dueAt - now, 0));
    }
  }

  async stop() {
    this.#started = false;
    this.#stopped = true;
    for (const [id, timer] of this.#timers) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
  }

  // --- mirror contract (bound chat) ------------------------------------------

  /** Send text to the bound chat; long text is split at the 4000-unit edge. */
  async sendText(text, { replyMarkup } = {}) {
    const ids = await this.#sendChunks(text, { target: this.#target, replyMarkup });
    return { messageId: ids[0] };
  }

  /** Send text split into parts; returns every provider message id. */
  async sendParts(text, { replyMarkup } = {}) {
    return this.#sendChunks(text, { target: this.#target, replyMarkup });
  }

  /**
   * Edit a bound-chat message. Throttled per message (Q21); no-op when the
   * text is unchanged (Q22); on failure falls back to a fresh send and
   * returns the new message id (Q22).
   */
  editText(messageId, text) {
    const id = String(messageId);
    if (this.#lastText.get(id) === text) return Promise.resolve({ messageId: id });
    return this.#enqueueEdit(id, text);
  }

  async deleteMessage(messageId) {
    const id = String(messageId);
    await this.#queued(() => this.#client.deleteMessage(this.#target, id));
    this.#lastText.delete(id);
  }

  // --- client shape (explicit target) ----------------------------------------

  async sendTo(target, text, { replyMarkup } = {}) {
    const ids = await this.#sendChunks(text, { target, replyMarkup });
    return { providerMessageIds: ids };
  }

  async editTargetText(target, messageId, text) {
    const id = String(messageId);
    if (this.#lastText.get(id) === text) return { messageId: id };
    return this.#enqueueEdit(id, text, { target });
  }

  async deleteTargetMessage(target, messageId) {
    await this.#queued(() => this.#client.deleteMessage(target, String(messageId)));
  }

  answerCallback(callbackQueryId, { text } = {}) {
    return this.#queued(() => this.#client.answerCallbackQuery(String(callbackQueryId), { text }));
  }

  editMessageReplyMarkup(target, { replyMarkup }) {
    return this.#queued(() => this.#client.editMessageReplyMarkup(target, { replyMarkup }));
  }

  // --- deferred delivery (section 7) ------------------------------------------

  /**
   * Schedule a send for later. Durable when a state store is wired in: the
   * row survives restarts and is re-scheduled by start(). Returns the id.
   */
  async deferSend({ id, sessionId, text, options = {}, dueAt } = {}) {
    const entryId = typeof id === 'string' && id ? id
      : `deferred-${this.#now()}-${Math.random().toString(36).slice(2, 10)}`;
    const entry = {
      id: entryId,
      key: this.#chatKey,
      sessionId: String(sessionId),
      status: 'pending',
      text: String(text),
      options,
      dueAt: Number.isFinite(dueAt) ? dueAt : this.#now(),
    };
    if (this.#state?.putDeferred) await this.#state.putDeferred(entry);
    this.#scheduleDeferred(entry, Math.max(entry.dueAt - this.#now(), 0));
    return entryId;
  }

  async cancelDeferred(id) {
    const key = String(id);
    const timer = this.#timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(key);
    }
    if (this.#state?.removeDeferred) await this.#state.removeDeferred(key);
  }

  // --- internals --------------------------------------------------------------

  /** Serialize one HTTP call against Telegram (single in-flight operation). */
  #queued(task) {
    const previous = this.#tail;
    const current = previous.then(() => {
      this.#inFlight += 1;
      return task().finally(() => {
        this.#inFlight -= 1;
      });
    });
    this.#tail = current.catch(() => {});
    return current;
  }

  /** Enforce the ~1 msg/s send gate and issue one sendMessage call. */
  async #gatedSend(target, chunk, options) {
    const now = this.#now();
    const wait = Math.max(this.#nextSendAt - now, 0);
    if (wait > 0) await this.#sleep(wait);
    this.#nextSendAt = Math.max(this.#nextSendAt, this.#now()) + this.#config.sendIntervalMs;
    return this.#queued(() => this.#client.sendText(target, chunk, options));
  }

  /** Split text and send chunk by chunk through the rate gate. */
  async #sendChunks(text, { target, replyMarkup }) {
    const chunks = splitTelegramRegularText(String(text));
    const ids = [];
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.#gatedSend(target, chunk, {
        replyMarkup: index === 0 ? replyMarkup : undefined,
      });
      const first = result?.providerMessageIds?.[0];
      if (first !== undefined && first !== null) ids.push(String(first));
    }
    if (ids.length === 0) {
      throw new Error('Telegram send returned no provider message ids');
    }
    return ids;
  }

  /** Register an edit job; per-message drainers apply them in order. */
  #enqueueEdit(messageId, text, { target } = {}) {
    return new Promise((resolve, reject) => {
      const queue = this.#editQueues.get(messageId) ?? [];
      queue.push({ target: target ?? this.#target, text, resolve, reject });
      this.#editQueues.set(messageId, queue);
      if (!this.#drainers.has(messageId)) {
        this.#drainers.add(messageId);
        void this.#drainEdits(messageId);
      }
    });
  }

  async #drainEdits(messageId) {
    try {
      for (;;) {
        const queue = this.#editQueues.get(messageId);
        if (!queue || queue.length === 0) return;
        const job = queue[0];
        const wait = this.#editWaitMs(messageId);
        if (wait > 0) await this.#sleep(wait);
        // Latest text wins (Q21): if a newer edit for this message arrived
        // while we throttled, this job is superseded.
        if (queue.length > 1) {
          queue.shift();
          job.resolve({ messageId });
          continue;
        }
        queue.shift();
        try {
          const outcome = await this.#applyEdit(job.target, messageId, job.text);
          this.#noteEdit(messageId);
          this.#lastText.set(messageId, job.text);
          job.resolve({ messageId: outcome.messageId });
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      this.#drainers.delete(messageId);
      const queue = this.#editQueues.get(messageId);
      if (queue && queue.length === 0) this.#editQueues.delete(messageId);
    }
  }

  /** Earliest allowed edit time for a message, claiming the next slot. */
  #editWaitMs(messageId) {
    const now = this.#now();
    let stamps = this.#editStamps.get(messageId);
    if (stamps) {
      const kept = stamps.filter((ts) => now - ts < this.#config.editBurstWindowMs);
      if (kept.length !== stamps.length) {
        this.#editStamps.set(messageId, kept);
        stamps = kept;
      }
    }
    let allowedAt = this.#nextEditAt.get(messageId) ?? now;
    if (stamps && stamps.length >= this.#config.editBurstMax) {
      allowedAt = Math.max(allowedAt, stamps[0] + this.#config.editBurstWindowMs);
    }
    const wait = Math.max(allowedAt - now, 0);
    this.#nextEditAt.set(messageId, Math.max(allowedAt, now) + this.#config.editIntervalMs);
    return wait;
  }

  #noteEdit(messageId) {
    const stamps = this.#editStamps.get(messageId) ?? [];
    stamps.push(this.#now());
    this.#editStamps.set(messageId, stamps);
  }

  /**
   * Apply one edit: 429 backoff (Q21), then fall back to a fresh send and
   * report the new message id (Q22) on any other failure.
   */
  async #applyEdit(target, messageId, text) {
    let lastError;
    for (let attempt = 1; attempt <= this.#config.retry429Max; attempt += 1) {
      try {
        await this.#queued(() => this.#client.editText(target, messageId, text));
        return { messageId };
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error)) break;
        await this.#sleep(Math.min(retryAfterMs(error, this.#config.retry429DelayMs), this.#config.retry429CapMs));
      }
    }
    if (isRateLimitError(lastError)) throw lastError;
    const ids = await this.#sendChunks(text, { target });
    return { messageId: ids[0] };
  }

  #scheduleDeferred(entry, delayMs) {
    if (this.#stopped) return;
    const timer = setTimeout(() => {
      void this.#fireDeferred(entry.id, entry);
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.#timers.set(entry.id, timer);
  }

  async #fireDeferred(id, entry) {
    this.#timers.delete(id);
    if (this.#stopped) return;
    if (!this.#started) {
      // Not up yet (start cancelled / never called): re-poll, keep the row.
      this.#scheduleDeferred(entry, this.#config.deferPollMs);
      return;
    }
    const rows = this.#state ? this.#state.deferredEntries() : null;
    const current = rows?.find((row) => row.id === id) ?? entry;
    if (!current || current.status !== 'pending') return;
    if (this.#state) {
      const bound = this.#state.sessionFor?.(this.#chatKey);
      if (bound && bound !== current.sessionId) {
        // The chat is bound to another session now: do not deliver; re-poll.
        this.#scheduleDeferred(current, this.#config.deferPollMs);
        return;
      }
    }
    try {
      await this.#sendChunks(current.text, {
        target: this.#target,
        replyMarkup: current.options?.replyMarkup,
      });
      if (this.#state?.removeDeferred) await this.#state.removeDeferred(id);
    } catch (error) {
      if (this.#state?.patchDeferred) await this.#state.patchDeferred(id, { status: 'failed' });
      this.#logger.warn?.('[dsh-im-multiagent] deferred delivery failed:', error);
    }
  }
}

function positive(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}