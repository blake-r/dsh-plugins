// dsh-im-multiagent InteractionAdapter (plan 6.8, stage 7b).
//
// Intercepts the host waterfall events `approval/request` and
// `user-questions/request` (global, prepend) and presents them in the
// Telegram chat where the session is mirrored, collecting the reply through
// the normal reply routing (MessageIndex, router rule 1).
//
// Escalation: when the GUI (or any other host) already owns the interaction
// (`hasActiveHarnessInteractionOwner`), the adapter calls `next()` and stays
// silent; with follow off it also defers to `next()` — the phone is a
// fallback channel, not a GUI competitor. Prompt texts and the approval
// dictionary are localized through the vendored harness-question /
// harness-approval modules (Q43/Q49, durable patch in src/).
import { randomUUID } from 'node:crypto';
import { hasActiveHarnessInteractionOwner } from '../../src/channels/shared/harness-client.mjs';
import { HarnessApprovalQueue } from '../../src/channels/shared/harness-approval.mjs';
import {
  validHarnessQuestion,
  harnessQuestionText,
  harnessAnswerForQuestion,
} from '../../src/channels/shared/harness-question.mjs';

function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents();
    if (Array.isArray(events)) return events;
  }
  const events = session?.events;
  return Array.isArray(events) ? events : null;
}

function questionError(message, code) {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  error.code = code;
  return error;
}

export class InteractionAdapter {
  #ctx;
  #state;
  #index;
  #mirror;
  #outbound;
  #chatKey;
  #i18n;
  #logger;
  #approvals;
  #questions = new Map();        // sessionId -> pending question
  #pendingApprovals = new Map(); // approvalId -> settle
  #actors = new Map();           // sessionId -> last senderId (task initiator)
  #disposers = [];
  #disposed = false;
  #started = false;

  constructor({ ctx, config, state, index, mirror, outbound, chatKey, i18n, logger = console }) {
    if (!ctx || !state || !index || !mirror || !outbound || !chatKey || !i18n) {
      throw new TypeError('InteractionAdapter requires ctx, state, index, mirror, outbound, chatKey, and i18n');
    }
    this.#ctx = ctx;
    this.#state = state;
    this.#index = index;
    this.#mirror = mirror;
    this.#outbound = outbound;
    this.#chatKey = chatKey;
    this.#i18n = i18n;
    this.#logger = logger;
    this.#approvals = new HarnessApprovalQueue({
      label: 'multiagent',
      logger,
      t: (key, params) => this.#i18n.t(key, params),
    });
  }

  /** Host scope used by the shared interaction-ownership registry. */
  get scope() {
    return this.#ctx?.root ?? this.#ctx;
  }

  get status() {
    return {
      pendingQuestions: [...this.#questions.keys()],
      pendingApprovals: [...this.#pendingApprovals.keys()],
    };
  }

  /** Subscribe to the host waterfall events (global, prepend). */
  start() {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    if (typeof this.#ctx?.on !== 'function') return;
    this.#disposers.push(this.#ctx.on(
      'approval/request',
      (request, next) => this.#requestApproval(request, next),
      { global: true, prepend: true },
    ));
    this.#disposers.push(this.#ctx.on(
      'user-questions/request',
      (request, next) => this.#requestQuestion(request, next),
      { global: true, prepend: true },
    ));
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#started = false;
    for (const dispose of this.#disposers.splice(0).reverse()) dispose?.();
    for (const pending of [...this.#questions.values()]) {
      pending.settle('cancelled', questionError('interaction adapter was disposed', 'ASK_ABORTED'));
    }
    for (const settle of [...this.#pendingApprovals.values()]) settle('cancelled');
  }

  /** Record the Telegram sender who last addressed a session (task initiator). */
  noteActor(sessionId, senderId) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const actor = String(senderId ?? '').trim();
    if (actor) this.#actors.set(sessionId, actor);
  }

  /** True when the session has a pending interaction that may consume a reply. */
  hasPending(sessionId) {
    return this.#questions.has(sessionId) || this.#approvals.hasPending(sessionId);
  }

  /**
   * Consume a user reply addressed to a session (router rule 1). Returns true
   * when the reply was absorbed by a pending interaction: an approval
   * decision, a question answer, or an unrecognized approval reply that stays
   * pending (Q49 — the message is absorbed, a localized re-prompt is sent).
   */
  async consumeReply(sessionId, message, chatKey) {
    const senderId = String(message?.senderId ?? '');
    const text = String(message?.content ?? '').trim();
    const addressed = message?.kind !== 'group' || message?.addressed === true;
    const pendingQuestion = this.#questions.get(sessionId);
    const approval = this.#approvals.claimReply({
      key: sessionId,
      actor: senderId,
      text,
      addressed,
      hasPendingQuestion: Boolean(pendingQuestion),
      questionCompletion: null,
      isQuestionPending: () => this.#questions.has(sessionId),
      send: (replyText) => this.#sendIndexed(sessionId, replyText),
    });
    if (approval) {
      await approval.process();
      return true;
    }
    if (pendingQuestion) {
      // Only the task initiator answers; anyone else's message routes to the
      // session as a normal message (bridge behavior).
      if (pendingQuestion.actor && pendingQuestion.actor !== senderId) return false;
      await this.#answerQuestion(pendingQuestion, text);
      return true;
    }
    return false;
  }

  // --- claimable session -----------------------------------------------------

  #claimableAgent(agent) {
    const session = agent?.session;
    const sessionId = session?.id ?? agent?.id;
    const events = sessionEvents(session);
    if (typeof sessionId !== 'string' || !events) return null;
    // Follow off: the user is at the workstation — GUI or the default decide.
    if (this.#state.mirroring().enabled !== true) return null;
    // The session must be known to the mirror roster.
    if (!this.#mirror.sessions()[sessionId]) return null;
    // A live GUI watcher owns the interaction — stay silent.
    if (hasActiveHarnessInteractionOwner(this.scope, sessionId, events)) return null;
    return { sessionId, events };
  }

  // --- questions -------------------------------------------------------------

  #requestQuestion(request, next) {
    const owner = this.#claimableAgent(request?.agent);
    if (!owner) return next();
    if (request.signal?.aborted) {
      return Promise.reject(questionError(
        'ask_user_question was aborted before the user answered', 'ASK_ABORTED',
      ));
    }
    const sessionId = owner.sessionId;
    if (this.#questions.has(sessionId)) {
      return Promise.reject(questionError(
        'another question is already pending for this session', 'ASK_ABORTED',
      ));
    }
    return new Promise((resolve, reject) => {
      const pending = {
        sessionId,
        questions: request.questions,
        signal: request.signal,
        actor: this.#actors.get(sessionId) ?? null,
        requiresMention: this.#chatKey.startsWith('group:'),
        index: 0,
        answers: [],
        settle: (outcome, value) => {
          if (!this.#questions.delete(sessionId)) return;
          request.signal?.removeEventListener('abort', onAbort);
          if (outcome === 'answered') resolve(value);
          else reject(value);
        },
      };
      const onAbort = () => pending.settle('cancelled', questionError(
        'ask_user_question was aborted before the user answered', 'ASK_ABORTED',
      ));
      this.#questions.set(sessionId, pending);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.#presentQuestion(pending).catch((error) => {
        this.#logger.error?.('[dsh-im-multiagent] failed to present a question:', error);
        pending.settle('cancelled', questionError(
          'failed to present the question in chat', 'ASK_ABORTED',
        ));
      });
    });
  }

  async #presentQuestion(pending) {
    const question = pending.questions[pending.index];
    const text = harnessQuestionText(question, pending.index, pending.questions.length, {
      requiresMention: pending.requiresMention,
      t: (key, params) => this.#i18n.t(key, params),
    });
    await this.#sendIndexed(pending.sessionId, text);
  }

  async #answerQuestion(pending, text) {
    const question = pending.questions[pending.index];
    pending.answers.push(harnessAnswerForQuestion(question, text));
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1;
      await this.#presentQuestion(pending);
      return;
    }
    const answer = {
      answers: pending.answers.map((item) => ({
        id: item.id,
        selected: [...item.selected],
        ...(item.custom === undefined ? {} : { custom: item.custom }),
      })),
    };
    pending.settle('answered', answer);
  }

  // --- approvals -------------------------------------------------------------

  #requestApproval(request, next) {
    const owner = this.#claimableAgent(request?.agent);
    if (!owner) return next();
    if (request.signal?.aborted) return Promise.resolve('cancelled');
    const claimed = new Set([...this.#pendingApprovals.keys()]);
    const decided = new Set();
    let approvalId;
    for (let index = owner.events.length - 1; index >= 0; index -= 1) {
      const event = owner.events[index];
      if (event.type === 'approval/decided') {
        decided.add(event.data?.id);
      } else if (event.type === 'approval/asked') {
        const id = event.data?.id;
        if (!id || decided.has(id) || claimed.has(id)) continue;
        if ((request.callId ?? null) !== (event.data?.callId ?? null)) continue;
        approvalId = id;
        break;
      }
    }
    if (approvalId === undefined) return next();
    // The tool call that triggered the approval lives in the session events
    // (tool/call); the vendored renderer needs it to show the operation.
    const toolCallEvent = [...owner.events].reverse().find((event) => (
      event.type === 'tool/call' && event.data?.callId === request.callId
    ));
    const toolCall = toolCallEvent?.data
      ? {
          callId: toolCallEvent.data.callId,
          name: toolCallEvent.data?.name,
          arguments: toolCallEvent.data?.arguments,
        }
      : undefined;
    return new Promise((resolve) => {
      const pending = {
        sessionId: owner.sessionId,
        approvalId,
        settle: (outcome) => {
          if (!this.#pendingApprovals.delete(approvalId)) return;
          request.signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
      };
      const onAbort = () => pending.settle('cancelled');
      this.#pendingApprovals.set(approvalId, pending);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const interaction = {
        kind: 'approval',
        rpcId: randomUUID(),
        sessionId: owner.sessionId,
        toolCall,
        payload: {
          type: 'approval/requested',
          sessionId: owner.sessionId,
          approvalId,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
        respond: async (result) => {
          pending.settle(result?.value?.outcome ?? 'rejected');
          return { accepted: true };
        },
      };
      this.#approvals.handleRequested(interaction, {
        key: owner.sessionId,
        actor: this.#actors.get(owner.sessionId) ?? null,
        requiresMention: this.#chatKey.startsWith('group:'),
        send: (text) => this.#sendIndexed(owner.sessionId, text),
      }).catch((error) => {
        this.#logger.error?.('[dsh-im-multiagent] failed to present an approval:', error);
        pending.settle('cancelled');
      });
    });
  }

  // --- outbound --------------------------------------------------------------

  async #sendIndexed(sessionId, text) {
    const { messageId } = await this.#outbound.sendText(text);
    await this.#index.put(this.#chatKey, { messageId, sessionId, direction: 'out' });
    return { messageId };
  }
}