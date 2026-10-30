/**
 * dsh-host-reasoning-loop-guard
 *
 * Host plugin: detects reasoning loops at streaming time and either aborts a
 * degenerate block (intra-block repetition) or reminds the model to make
 * progress (cross-block repetition across steps).
 *
 * Observation (per plan §4.1): reasoning arrives incrementally via
 * `agent/assistant-stream` frames (start / chunk type "reasoning-delta" / end).
 * Deltas accumulate per attemptId; the accumulated text is cut into segments of
 * `segmentChars` chars; each new segment is fed to the N-gram Window Filter
 * over a rolling window of the last `window` segments.
 *
 * Detection (per plan §4.2) is incremental: each segment contributes its word
 * n-grams (plus boundary n-grams with the previous segment) to a per-gram
 * counter that tracks occurrences per attempt. A gram whose total count
 * exceeds `maxRepeats` is attributed:
 *   - intra-block: the current attempt alone holds more than `maxRepeats`
 *     occurrences (the model repeats a phrase/paragraph within one reasoning
 *     block, burning the context window). Action: abort the request
 *     (agent.cancel({kind:'hook', reason}, {keepInbox:true})) and resend a reminder via
 *     agent.steer() so the next turn starts with the injected content.
 *   - cross-block: the total exceeds `maxRepeats` but the current attempt
 *     alone does not (the model thinks the same across steps even when tool
 *     calls differ). Consecutive signal steps are counted; reminders are
 *     injected at thresholds [3, 5, 8] via agent/pre-step.
 *
 * Degenerate-output guard: word n-grams are blind to character-level runs — a
 * no-space repetition ("иии…") is a single word and produces zero grams. Each
 * segment is therefore also measured by two run-length meters (maxCharRun /
 * maxTokenRun from dsh-loop-guard-shared); a segment whose longest
 * identical-character run reaches `charRunThreshold` or whose longest
 * identical-token run reaches `tokenRunThreshold` is treated as an intra-block
 * signal ("degenerate-output") with the same abort semantics as an n-gram
 * repeat.
 *
 * Reset semantics: a user message keeps the segment window (repetition after
 * a user message is still a loop) but restarts the escalation ladder; the
 * window and counters are fully cleared on compaction and on an intra abort.
 *
 * Cost: O(1) per segment (bounded window), O(N) per session.
 *
 * The default export is the Cordis plugin function (ctx, config); the named
 * export `createThinkingDetector(cfg)` is a pure factory (no ctx, no cordis).
 */

import { randomUUID } from 'node:crypto';
import * as shared from './dsh-loop-guard-shared.mjs';

export const name = 'dsh-host-reasoning-loop-guard';

const PLUGIN_NAME = 'dsh-host-reasoning-loop-guard';

const DEFAULT_THRESHOLDS = [3, 5, 8];
// Rolling window of recent segments fed to the N-gram filter.
// window=48 / n=24 chosen from the sweep: FP 3.3% on genuinely-normal sessions,
// detection 24/24, audit fires, intra-block parity intact (plan §8 gate).
const DEFAULT_WINDOW = 48;
const DEFAULT_N = 24;
const DEFAULT_MAX_REPEATS = 2;
const DEFAULT_SEGMENT_CHARS = 256;
const DEFAULT_ABORT_INTRA_BLOCK = true;

// Degenerate-output thresholds: longest identical-character / identical-token
// run per segment that trips an intra-block signal regardless of n-grams.
const DEFAULT_CHAR_RUN_THRESHOLD = 64;
const DEFAULT_TOKEN_RUN_THRESHOLD = 8;

const DEFAULT_PHRASES = {
  gentle:
    'Your reasoning is repeating the same phrase or conclusion across consecutive steps. Analyze the latest results and make concrete progress: take a different action, inspect different evidence, or finish the task. Do not re-derive the same conclusion again.',
  repeat:
    'Reasoning loop detected:\n- repeated_phrase: {phrase}\n- consecutive_steps: {count}\nYour reasoning is not making progress. Stop re-deriving this conclusion. Inspect the latest tool results and either take a concrete action or finish the task.',
  intraBlock:
    'Your reasoning is repeating the same phrase or paragraph within a single reasoning block, consuming the context window. Stop and make concrete progress: take a different action, inspect different evidence, or finish the task. Do not repeat the same passage again.',
};

// Export the defaults so consumers (replay gates) build a naive reference with
// the exact same parameters instead of hard-coded copies.
export const DEFAULT_THINK_CONFIG = {
  thresholds: DEFAULT_THRESHOLDS,
  window: DEFAULT_WINDOW,
  n: DEFAULT_N,
  maxRepeats: DEFAULT_MAX_REPEATS,
  segmentChars: DEFAULT_SEGMENT_CHARS,
  abortIntraBlock: DEFAULT_ABORT_INTRA_BLOCK,
  charRunThreshold: DEFAULT_CHAR_RUN_THRESHOLD,
  tokenRunThreshold: DEFAULT_TOKEN_RUN_THRESHOLD,
  phrases: DEFAULT_PHRASES,
};

/** Validate `thresholds`: integers >= 2, no duplicates, returned sorted ascending. */
function validateThresholds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${PLUGIN_NAME}: \`thresholds\` must be a non-empty array`);
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`${PLUGIN_NAME}: invalid threshold ${value} — every threshold must be an integer >= 2`);
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${PLUGIN_NAME}: \`thresholds\` must not contain duplicates`);
  }
  return [...values].sort((a, b) => a - b);
}

function assertInt(name, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${PLUGIN_NAME}: invalid ${name} ${value} — must be an integer >= ${min}`);
  }
}

/** Validate the thinking-plugin config fail-loud and return normalized defaults. */
function validateConfig(cfg) {
  const config = cfg ?? {};
  const thresholds = validateThresholds(config.thresholds ?? DEFAULT_THRESHOLDS);
  const window = config.window ?? DEFAULT_WINDOW;
  assertInt('window', window, 1);
  const n = config.n ?? DEFAULT_N;
  assertInt('n', n, 1);
  const maxRepeats = config.maxRepeats ?? DEFAULT_MAX_REPEATS;
  assertInt('maxRepeats', maxRepeats, 1);
  const segmentChars = config.segmentChars ?? DEFAULT_SEGMENT_CHARS;
  assertInt('segmentChars', segmentChars, 1);
  const abortIntraBlock = config.abortIntraBlock ?? DEFAULT_ABORT_INTRA_BLOCK;
  const charRunThreshold = config.charRunThreshold ?? DEFAULT_CHAR_RUN_THRESHOLD;
  assertInt('charRunThreshold', charRunThreshold, 2);
  const tokenRunThreshold = config.tokenRunThreshold ?? DEFAULT_TOKEN_RUN_THRESHOLD;
  assertInt('tokenRunThreshold', tokenRunThreshold, 2);
  const phrases = {
    gentle: config.phrases?.gentle ?? DEFAULT_PHRASES.gentle,
    repeat: config.phrases?.repeat ?? DEFAULT_PHRASES.repeat,
    intraBlock: config.phrases?.intraBlock ?? DEFAULT_PHRASES.intraBlock,
  };
  return { thresholds, window, n, maxRepeats, segmentChars, abortIntraBlock, charRunThreshold, tokenRunThreshold, phrases };
}

/** Substitute `{key}` placeholders with the corresponding reminder fields. */
function renderPhrase(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/** Collapse whitespace, trim, lowercase. */
function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Pure reasoning-loop detector factory (v3, streaming-time, incremental).
 * @param {object} cfg - normalized thinking-plugin config.
 * @returns {{
 *   beginAttempt: (attemptId: string) => void,
 *   pushChunk: (text: string, attemptId: string) => object|null,
 *   endAttempt: (attemptId: string) => object|null,
 *   discardAttempt: (attemptId: string) => void,
 *   observeBlock: (text: string) => { reminder: object|null, intra: string|null },
 *   reset: () => void,
 * }}
 */
export function createThinkingDetector(cfg) {
  const config = validateConfig(cfg);
  const thresholds = config.thresholds;
  const thresholdSet = new Set(thresholds);
  const lastThreshold = thresholds[thresholds.length - 1];

  // Rolling window of normalized segments; each carries the word n-grams it
  // contributed (including boundary n-grams with the previous segment).
  const segments = []; // [{ text, attemptId, grams: [string] }]
  // gram -> { count, attempts: Map<attemptId, count> }
  const gramCounts = new Map();
  // Per-attempt streaming state; consecutive cross-block signal steps; last
  // detected repeated n-gram.
  let attemptId = null;
  let attemptBuf = '';
  let attemptSignal = null; // { gram } — first cross-block gram of this attempt
  let abortedThisAttempt = false;
  let count = 0;
  let lastGram = null;
  let blockCounter = 0;

  /** Increment the occurrence count of one gram for `id`. */
  function addGram(gram, id) {
    let entry = gramCounts.get(gram);
    if (!entry) {
      entry = { count: 0, attempts: new Map() };
      gramCounts.set(gram, entry);
    }
    entry.count += 1;
    entry.attempts.set(id, (entry.attempts.get(id) ?? 0) + 1);
  }

  /** Decrement the occurrence count of one gram for `id` (window eviction). */
  function removeGram(gram, id) {
    const entry = gramCounts.get(gram);
    if (!entry) return;
    entry.count -= 1;
    const remaining = entry.attempts.get(id) - 1;
    if (remaining > 0) entry.attempts.set(id, remaining);
    else entry.attempts.delete(id);
    if (entry.count <= 0) gramCounts.delete(gram);
  }

  /**
   * Word n-grams of `text` plus boundary n-grams spanning the seam with
   * `prevTail` — only when the previous segment belongs to the same attempt
   * (a seam between attempts must not count toward the current attempt's
   * intra count).
   */
  function gramsOf(text, prevTail, prevTailId, id) {
    const words = text.split(' ');
    const grams = [];
    for (let i = 0; i + config.n <= words.length; i += 1) {
      grams.push(words.slice(i, i + config.n).join(' '));
    }
    if (prevTail && prevTailId === id) {
      const tail = prevTail.split(' ');
      const joined = [...tail, ...words];
      for (let i = Math.max(0, tail.length - config.n + 1); i + config.n <= joined.length && i < tail.length; i += 1) {
        grams.push(joined.slice(i, i + config.n).join(' '));
      }
    }
    return grams;
  }

  /** Run detection for one new segment; returns {kind, gram} or null. */
  function observeSegment(text, id) {
    const current = normalize(text);
    if (!current) return null;
    // Degenerate-output guard: word n-grams cannot see character/token-level
    // runs (a no-space run is a single word), so measure them directly.
    const degenerate =
      shared.maxCharRun(current) >= config.charRunThreshold ||
      shared.maxTokenRun(current) >= config.tokenRunThreshold;
    const prev = segments.length > 0 ? segments[segments.length - 1] : null;
    const grams = gramsOf(current, prev?.text, prev?.attemptId, id);
    // Internal grams belong to the current segment; boundary grams (spanning
    // the seam with `prev`) are attributed to `prev` instead. A boundary gram
    // is only visible in the naive joined text while BOTH of its halves are
    // in the window; `prev` is the older half, so it is evicted first — the
    // boundary gram must leave the counters exactly when `prev` leaves the
    // window, or the incremental detector overcounts it.
    const words = current.split(' ');
    const internalCount = Math.max(0, words.length - config.n + 1);
    const internal = grams.slice(0, internalCount);
    const boundary = grams.slice(internalCount);
    segments.push({ text: current, attemptId: id, grams: internal });
    if (prev && prev.attemptId === id) {
      prev.grams.push(...boundary);
      for (const gram of boundary) addGram(gram, id);
    }
    while (segments.length > config.window) {
      const evicted = segments.shift();
      for (const gram of evicted.grams) removeGram(gram, evicted.attemptId);
    }

    // Add every gram of the segment first so the segment's `grams` list always
    // matches gramCounts: an intra `break` in the signal loop below must not
    // leave un-added grams behind, or a later window eviction would decrement
    // counters for grams that were never added.
    for (const gram of internal) addGram(gram, id);

    let result = null;
    for (const gram of grams) {
      const entry = gramCounts.get(gram);
      if (entry.count > config.maxRepeats) {
        const inCurrent = entry.attempts.get(id) ?? 0;
        if (inCurrent > config.maxRepeats) {
          result = { kind: 'intra', gram };
          break;
        }
        if (!result) result = { kind: 'cross', gram };
      }
    }
    // Degenerate output outranks a cross-block signal within this segment.
    if (degenerate && (!result || result.kind === 'cross')) {
      result = { kind: 'intra', gram: 'degenerate-output' };
    }
    if (result?.kind === 'cross') attemptSignal = attemptSignal ?? { gram: result.gram };
    return result;
  }

  /** Open a new attempt (start frame). */
  function beginAttempt(id) {
    attemptId = id;
    attemptBuf = '';
    attemptSignal = null;
    abortedThisAttempt = false;
  }

  /**
   * Accumulate one reasoning delta and run detection on completed segments.
   * Returns the first intra signal (wins immediately) or the first cross
   * signal of this chunk, or null.
   */
  function pushChunk(text, id) {
    if (id !== attemptId) return null;
    attemptBuf += text;
    let result = null;
    while (attemptBuf.length >= config.segmentChars) {
      const res = observeSegment(attemptBuf.slice(0, config.segmentChars), id);
      attemptBuf = attemptBuf.slice(config.segmentChars);
      if (res?.kind === 'intra') return res;
      if (res && !result) result = res;
    }
    return result;
  }

  /**
   * Finalize the current attempt (committed end frame): flush the trailing
   * partial segment, update the cross-block counter, and return
   * `{ reminder, intra }` — the cross-block reminder to deliver at the next
   * pre-step (or null) and the intra gram if the trailing partial segment
   * crossed the intra threshold (the block is already committed by then, so
   * the plugin cannot abort; the signal is still exposed for replay/parity).
   */
  function endAttempt(id) {
    if (id !== attemptId) return null;
    let intra = null;
    if (attemptBuf.length > 0) {
      const res = observeSegment(attemptBuf, id);
      if (res?.kind === 'intra') intra = res.gram;
    }
    attemptId = null;
    attemptBuf = '';
    abortedThisAttempt = false;
    let reminder = null;
    if (attemptSignal) {
      count += 1;
      lastGram = attemptSignal.gram;
      if (count === thresholds[0]) {
        reminder = { level: 'gentle', count, signal: 'ngram', phrase: lastGram };
      } else if (thresholdSet.has(count) || count > lastThreshold) {
        reminder = { level: 'repeat', count, signal: 'ngram', phrase: lastGram };
      }
    } else {
      // No cross signal: start a new run.
      count = 1;
      lastGram = null;
    }
    attemptSignal = null;
    return { reminder, intra };
  }

  /** Drop an abandoned attempt (retry): remove its segments, keep counters. */
  function discardAttempt(id) {
    if (id !== attemptId) return;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i].attemptId === id) {
        const evicted = segments.splice(i, 1)[0];
        for (const gram of evicted.grams) removeGram(gram, evicted.attemptId);
      }
    }
    attemptId = null;
    attemptBuf = '';
    attemptSignal = null;
    abortedThisAttempt = false;
  }

  /**
   * Replay convenience: feed one whole reasoning block (split into segments)
   * and return the cross-block reminder plus the first intra gram, if any.
   */
  function observeBlock(text) {
    const id = `block-${blockCounter++}`;
    beginAttempt(id);
    let buf = String(text);
    let intra = null;
    while (buf.length >= config.segmentChars) {
      const res = pushChunk(buf.slice(0, config.segmentChars), id);
      if (res?.kind === 'intra' && !intra) intra = res.gram;
      buf = buf.slice(config.segmentChars);
    }
    if (buf.length > 0) {
      const res = pushChunk(buf, id);
      if (res?.kind === 'intra' && !intra) intra = res.gram;
    }
    const res = endAttempt(id);
    if (res?.intra && !intra) intra = res.intra;
    return { reminder: res?.reminder, intra };
  }

  /**
   * User message arrived: keep the segment window (repetition after a user
   * message is still a loop), but restart the escalation ladder — the user
   * intervention breaks the run of consecutive signal steps.
   */
  function onUserMessage() {
    attemptId = null;
    attemptBuf = '';
    attemptSignal = null;
    abortedThisAttempt = false;
    count = 1;
    lastGram = null;
  }

  /** Clear the window and counters (compaction, intra abort). */
  function reset() {
    segments.length = 0;
    gramCounts.clear();
    attemptId = null;
    attemptBuf = '';
    attemptSignal = null;
    abortedThisAttempt = false;
    count = 0;
    lastGram = null;
  }

  return { beginAttempt, pushChunk, endAttempt, discardAttempt, observeBlock, onUserMessage, reset };
}

/** Build a user reminder message with the plugin source, per plan §4.3. */
function buildReminderMessage(phrases, reminder) {
  const summary = `reasoning loop × ${reminder.count}`;
  const text =
    reminder.level === 'gentle'
      ? renderPhrase(phrases.gentle, reminder)
      : renderPhrase(phrases.repeat, reminder);
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: `plugin:${PLUGIN_NAME}`, form: 'notice', summary },
  };
}

/** Build the intra-block reminder delivered via agent.steer (plan §4.2). */
function buildIntraBlockMessage(phrases, gram) {
  const text = renderPhrase(phrases.intraBlock, { phrase: gram });
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: `plugin:${PLUGIN_NAME}`, form: 'notice', summary: 'reasoning loop × intra-block' },
  };
}

/**
 * Cordis host plugin entry point. Validates config fail-loud, accumulates
 * reasoning from `agent/assistant-stream` at streaming time, aborts degenerate
 * blocks (intra) and injects cross-block reminders via `agent/pre-step`.
 */
export default function reasoningLoopGuardPlugin(ctx, config) {
  const resolved = validateConfig(config);
  const detectors = new WeakMap();
  const pendingReminders = new WeakMap(); // agent -> cross-block reminder
  const agentsBySession = new Map(); // sessionId -> Set<agent>

  function detectorFor(agent) {
    let detector = detectors.get(agent);
    if (!detector) {
      detector = createThinkingDetector(resolved);
      detectors.set(agent, detector);
      const sessionId = agent.session?.id;
      if (sessionId) {
        let set = agentsBySession.get(sessionId);
        if (!set) {
          set = new Set();
          agentsBySession.set(sessionId, set);
        }
        set.add(agent);
      }
    }
    return detector;
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      detectorFor(agent).beginAttempt(frame.attemptId);
      return;
    }
    if (frame.type === 'chunk') {
      if (frame.chunk?.type !== 'reasoning-delta' || typeof frame.chunk.text !== 'string') return;
      const res = detectorFor(agent).pushChunk(frame.chunk.text, frame.attemptId);
      if (res?.kind === 'intra' && resolved.abortIntraBlock) {
        detectorFor(agent).reset();
        shared.clearHardCancel(agent);
        const message = buildIntraBlockMessage(resolved.phrases, res.gram);
        // Steer BEFORE the cancel: the message lands in next-step before the
        // abort reclassifies it, and the resume path of the dsh-agent-loop
        // patch carries it into the running turn's next step (a true steer).
        agent.steer(message);
        agent.cancel({ kind: 'hook', reason: `reasoning loop: repeated phrase "${res.gram}" within one reasoning block` }, {
          keepInbox: true,
        });
      }
      return;
    }
    if (frame.type === 'end') {
      if (frame.outcome?.kind === 'committed') {
        const res = detectorFor(agent).endAttempt(frame.attemptId);
        if (res?.reminder) pendingReminders.set(agent, res.reminder);
      } else if (frame.outcome?.kind === 'abandoned') {
        detectorFor(agent).discardAttempt(frame.attemptId);
      }
    }
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent;
    const hasUserMessage = payload.messages.some((m) => m.source?.kind === 'user' || m.source?.kind === 'goal');
    const decision = await next();
    const detector = detectorFor(agent);

    if (hasUserMessage) {
      detector.onUserMessage();
      pendingReminders.delete(agent);
      shared.clear(agent);
      shared.clearHardCancel(agent);
      return decision;
    }

    const reminder = pendingReminders.get(agent);
    pendingReminders.delete(agent);
    if (!reminder) return decision;
    if (decision.kind !== 'enter') return decision;

    // Coordination (read-and-clear): a tool reminder already went in this step.
    const toolInjected = shared.wasToolInjected(agent);
    shared.clear(agent);
    if (toolInjected) return decision;
    shared.markThinkingInjected(agent);

    const message = buildReminderMessage(resolved.phrases, reminder);
    return { ...decision, messages: [...decision.messages, message] };
  });

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return;
    const set = agentsBySession.get(session.id);
    if (!set) return;
    for (const agent of set) {
      detectors.get(agent)?.reset();
      pendingReminders.delete(agent);
      shared.clear(agent);
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent.session?.id;
    if (sessionId) {
      const set = agentsBySession.get(sessionId);
      if (set) {
        set.delete(agent);
        if (set.size === 0) agentsBySession.delete(sessionId);
      }
    }
    detectors.delete(agent);
    pendingReminders.delete(agent);
  });
}