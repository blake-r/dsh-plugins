/**
 * dsh-loop-guard-shared
 *
 * Per-agent coordination between the tool-pattern reminder
 * (dsh-host-repeat-pattern-reminder) and the reasoning loop guard
 * (dsh-host-reasoning-loop-guard), plus the JS port of the three detection
 * primitives (reference implementation: loop-detectors.ts).
 *
 * Coordination — the two detectors can fire on the same agent step (the
 * thinking guard on `agent/pre-step` and the tool detector on
 * `tools/post-execute`) and both would otherwise inject a reminder into the
 * next step's context, producing a duplicate reminder on one step. This module
 * keeps one shared flag pair per agent so the two plugins never double-inject.
 *
 * Read-and-clear rule (each plugin applies it on its own hook):
 *   - thinking on pre-step:  clear own flag; if `toolInjected`, clear it and
 *     skip injection (detection and counting continue); otherwise inject and
 *     `markThinkingInjected`.
 *   - tool on post-execute:  clear own flag; if `thinkingInjected`, clear it
 *     and skip; otherwise inject and `markToolInjected`.
 *
 * Both flags are cleared together by `clear(agent)` on every read-and-clear
 * hand-off and when a user message arrives. `clear` resets ONLY those two
 * flags: a pending hard cancel staged by `markHardCancelPending` is separate
 * state and is dropped only by `clearHardCancel` (it would otherwise be wiped
 * by the very next reminder injection, so the escalation could never reach the
 * generation boundary that consumes it).
 *
 * Detection primitives (v2, per plan §11):
 *   - detectTextLoop(text, n, maxRepeats) — N-gram Window Filter; returns the
 *     repeated n-gram or null (the TS reference returns boolean).
 *   - detectCycle(ids) — Floyd's "Tortoise and Hare" on a sequence of ids.
 *   - cyclePeriod(ids) — smallest period p >= 2 of a periodic tail, or null.
 *   - createAgentLoopDetector(maxAllowedRepeats) — state hashing: MD5 of the
 *     tool name + canonical (key-sorted) arguments; registerStep returns true
 *     when the current call repeats more than `maxAllowedRepeats` times.
 *   - maxCharRun(text) / maxTokenRun(text) — degenerate-output meters: longest
 *     contiguous run of one character / one token. Word n-grams cannot see a
 *     no-space run ("иии…") because it is a single word producing zero grams,
 *     so these feed the reasoning guard's degenerate-output signal.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

const flags = new WeakMap();

function entry(agent) {
  let e = flags.get(agent);
  if (!e) {
    e = { thinkingInjected: false, toolInjected: false, pendingHardCancel: null };
    flags.set(agent, e);
  }
  return e;
}

/** Record that the thinking guard injected a reminder for `agent` this step. */
export function markThinkingInjected(agent) {
  if (!agent) return;
  entry(agent).thinkingInjected = true;
}

/** Record that the tool detector injected a reminder for `agent` this step. */
export function markToolInjected(agent) {
  if (!agent) return;
  entry(agent).toolInjected = true;
}

/** Whether the thinking guard injected for `agent` since the last clear. */
export function wasThinkingInjected(agent) {
  return Boolean(agent) && (flags.get(agent)?.thinkingInjected ?? false);
}

/** Whether the tool detector injected for `agent` since the last clear. */
export function wasToolInjected(agent) {
  return Boolean(agent) && (flags.get(agent)?.toolInjected ?? false);
}

/**
 * Drop both coordination flags for `agent` (read-and-clear hand-off), keeping
 * any pending hard-cancel reminder staged on the same entry.
 */
export function clear(agent) {
  if (!agent) return;
  const e = flags.get(agent);
  if (!e) return;
  e.thinkingInjected = false;
  e.toolInjected = false;
}

// ---------------------------------------------------------------------------
// Hard-cancel coordination (repeat-pattern escalation)
// ---------------------------------------------------------------------------
//
// One pending hard-cancel slot per agent (no stack). The tool detector sets
// it at `tools/post-execute` once its escalation threshold is crossed; the
// escalation consumes it at the next `agent/assistant-stream` start, when the
// inbox next-step is empty so an abort ends the turn instead of resuming it
// (the resume-same-turn path of the dsh-agent-loop patch requires a non-empty
// next-step). A user message and the reasoning guard's own intra-block abort
// clear it so two cancels never fire for one loop.

/** Stage one hard-cancel reminder for `agent` (replaces any pending one). */
export function markHardCancelPending(agent, message) {
  if (!agent) return;
  entry(agent).pendingHardCancel = message;
}

/** Read the pending hard-cancel reminder without consuming it, or null. */
export function peekHardCancel(agent) {
  return Boolean(agent) ? (flags.get(agent)?.pendingHardCancel ?? null) : null;
}

/** Consume and return the pending hard-cancel reminder, or null. */
export function consumeHardCancel(agent) {
  if (!agent) return null;
  const e = flags.get(agent);
  if (!e) return null;
  const message = e.pendingHardCancel;
  e.pendingHardCancel = null;
  return message;
}

/** Drop a pending hard-cancel reminder (user message, intra abort). */
export function clearHardCancel(agent) {
  if (agent) {
    const e = flags.get(agent);
    if (e) e.pendingHardCancel = null;
  }
}

// ---------------------------------------------------------------------------
// Detection primitives
// ---------------------------------------------------------------------------

/** Deep key-sort of a parsed-JSON value (identical to the base plugin). */
export function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const record = value;
    const sorted = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
export function canonicalizeArgs(argumentsValue) {
  return JSON.stringify(sortJsonValue(argumentsValue));
}

/** MD5 hex digest of a string (state hashing). */
export function md5Hex(text) {
  return createHash('md5').update(text).digest('hex');
}

/**
 * N-gram Window Filter (JS port of detectTextLoop). Splits `text` into words,
 * lowercases, builds n-grams, and returns the first n-gram occurring more than
 * `maxRepeats` times, or null. Truthiness of the return value is the loop
 * signal; the returned gram is used for the reminder message.
 */
export function detectTextLoop(text, n = 4, maxRepeats = 2) {
  const words = String(text).toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < n) return null;
  const counts = new Map();
  for (let i = 0; i + n <= words.length; i += 1) {
    const gram = words.slice(i, i + n).join(' ');
    const next = (counts.get(gram) ?? 0) + 1;
    if (next > maxRepeats) return gram;
    counts.set(gram, next);
  }
  return null;
}

/**
 * Longest contiguous run of identical characters in `text`, or 0 when empty.
 */
export function maxCharRun(text) {
  let best = 0;
  let run = 0;
  let prev = '';
  for (const ch of String(text)) {
    if (ch === prev) run += 1;
    else {
      run = 1;
      prev = ch;
    }
    if (run > best) best = run;
  }
  return best;
}

/**
 * Longest consecutive run of identical tokens after whitespace split, or 0
 * when empty. Catches short spaced repeats ("и и и …") whose word count is
 * below the n-gram length and therefore invisible to word n-grams.
 */
export function maxTokenRun(text) {
  const tokens = String(text).toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const tok of tokens) {
    if (tok === prev) run += 1;
    else {
      run = 1;
      prev = tok;
    }
    if (run > best) best = run;
  }
  return best;
}

/**
 * Floyd's Cycle-Finding ("Tortoise and Hare") on a sequence of state ids.
 * O(1) extra memory. Returns true when the sequence is periodic.
 */
export function detectCycle(ids) {
  if (ids.length < 2) return false;
  let tortoise = 0;
  let hare = 0;
  while (true) {
    tortoise += 1;
    hare += 2;
    if (hare >= ids.length) return false;
    if (ids[tortoise] === ids[hare]) return true;
  }
}

/**
 * Smallest period p >= 2 such that the tail is p-periodic (ids[i] == ids[i-p]
 * for all i >= p), or null. Requires at least 3 repetitions to be meaningful.
 */
export function cyclePeriod(ids) {
  for (let p = 2; p * 3 <= ids.length; p += 1) {
    let ok = true;
    for (let i = p; i < ids.length; i += 1) {
      if (ids[i] !== ids[i - p]) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return null;
}

/**
 * State-hashing detector (JS port of AgentLoopDetector). Keeps a bounded
 * history of MD5 state ids; `registerStep` returns true when the current call
 * is already duplicated in the history more than `maxAllowedRepeats` times.
 */
export function createAgentLoopDetector(maxAllowedRepeats = 3) {
  const MAX_HISTORY = 64;
  const history = [];
  const detector = {
    registerStep(toolName, payload) {
      const hash = detector.hashOf(toolName, payload);
      const occurrences = history.filter((h) => h === hash).length;
      history.push(hash);
      if (history.length > MAX_HISTORY) history.shift();
      return occurrences >= maxAllowedRepeats;
    },
    occurrences(toolName, payload) {
      const hash = detector.hashOf(toolName, payload);
      return history.filter((h) => h === hash).length;
    },
    hashOf(toolName, payload) {
      return md5Hex(`${toolName}\u0000${canonicalizeArgs(payload)}`);
    },
    /** The bounded history of state ids (most recent last). */
    history() {
      return history;
    },
    reset() {
      history.length = 0;
    },
  };
  return detector;
}