/**
 * dsh-host-repeat-pattern-reminder
 *
 * Host plugin: detects repeated tool calls by state hashing (MD5 of the tool
 * name + canonical arguments) and complex alternations by Floyd's cycle
 * finding, and reminds the model to change course. It is a drop-in,
 * period-1-compatible replacement for the base `repeat-tool-reminder`,
 * extended to alternating patterns such as `read -> bash -> read -> bash`.
 *
 * Detection (v2, per plan §11 — primitives in dsh-loop-guard-shared.mjs,
 * reference implementation loop-detectors.ts):
 *   - state id = md5(toolName + canonicalize(arguments));
 *   - state hashing: a reminder fires when the same state id occurs exactly
 *     `thresholds` times in the recent history (3, 5 and 8 by default, parity
 *     with the base plugin); the count of reminders per run is therefore
 *     bounded, so a long run cannot turn into one injected notice per call;
 *   - Floyd's cycle finding: when the recent state-id tail is a cycle of
 *     period >= 2 repeated at least `thresholds[0]` times, a reminder fires
 *     with that period (one reminder per cycle, at most once per period).
 *
 * Budgets: at most one reminder per agent step, with no per-turn ceiling. One
 * assistant message may carry hundreds of identical parallel calls (a real
 * session: 1001 `list_agents` calls in one step); such a batch is still ONE
 * step, so it gets one reminder instead of one per call.
 *
 * Injection: `tools/post-execute` stages the notice, `agent/pre-step` prepends
 * it to the messages of the next step. A whole batch is therefore summarised
 * once, after it finished, never once per call. Reset on a user or goal message
 * in `agent/pre-step`, per-step slot reopened on every `agent/pre-step`.
 * Coordination with the reasoning loop guard via dsh-loop-guard-shared
 * (read-and-clear).
 *
 * The default export is the Cordis plugin function (ctx, config); the named
 * export `createToolDetector(cfg)` is a pure factory (no ctx, no cordis).
 */

import { randomUUID } from 'node:crypto';
import * as shared from './dsh-loop-guard-shared.mjs';

export const name = 'dsh-host-repeat-pattern-reminder';

const PLUGIN_NAME = 'dsh-host-repeat-pattern-reminder';

const DEFAULT_THRESHOLDS = [3, 5, 8];
// State-hash limit: registerStep returns true when the current call is already
// duplicated more than `maxAllowedRepeats` times. Default 2 -> fires at the
// 3rd occurrence, matching the base plugin's first threshold.
const DEFAULT_MAX_ALLOWED_REPEATS = 2;
const DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500;
// Floyd's window: the recent state-id tail checked for cycles.
const CYCLE_WINDOW = 32;

const DEFAULT_PHRASES = {
  gentle:
    'You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.',
  repeat:
    'Repeated tool call detected:\n- tool: {toolName}\n- period: {period}\n- consecutive_calls: {consecutive}\n- arguments: {argumentsPreview}\nThe repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.',
  hardCancel:
    'Hard loop interrupted: {toolName} was called with identical arguments {count} times in a row and the turn was stopped. Do not repeat this call. Inspect the latest tool results and either take a concrete different action or finish the task.',
};

// Escalation: after this many identical consecutive calls the detector stops
// injecting soft reminders and stages a hard cancel (abort + reminder) for the
// next generation. Mirrors the observed failure (3b3ffc: ~27 identical calls,
// 208 ignored soft injections — only the hard cancel stopped the loop).
const DEFAULT_ESCALATE_CONSECUTIVE = 10;
// Minimum interval between two hard cancels for one agent.
const DEFAULT_HARD_CANCEL_COOLDOWN_MS = 60_000;
// Escalating driver-backoff windows: after a hard cancel the goal is disarmed
// for this long so a looped model cannot burn goal rounds while it keeps
// looping; the ladder escalates with repeated cancels.
const DEFAULT_DRIVER_BACKOFF_MINUTES = [2, 5, 15];

/** Compile one `*`-wildcard pattern to an anchored RegExp (other metachars literal). */
function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`);
}

/** Head-truncate the canonical arguments for quoting in the detailed reminder. */
function previewArguments(canonical, cap) {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

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

/** Validate the tool-plugin config fail-loud and return normalized defaults. */
function validateConfig(cfg) {
  const config = cfg ?? {};
  const thresholds = validateThresholds(config.thresholds ?? DEFAULT_THRESHOLDS);
  const maxAllowedRepeats = config.maxAllowedRepeats ?? DEFAULT_MAX_ALLOWED_REPEATS;
  if (!Number.isInteger(maxAllowedRepeats) || maxAllowedRepeats < 1) {
    throw new Error(`${PLUGIN_NAME}: invalid maxAllowedRepeats ${maxAllowedRepeats} — must be an integer >= 1`);
  }
  const argumentsPreviewChars = config.argumentsPreviewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`${PLUGIN_NAME}: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`);
  }
  const include = (config.include ?? []).map(String);
  const exclude = (config.exclude ?? []).map(String);
  const escalateConsecutive = config.escalateConsecutive ?? DEFAULT_ESCALATE_CONSECUTIVE;
  if (!Number.isInteger(escalateConsecutive) || escalateConsecutive < 1) {
    throw new Error(`${PLUGIN_NAME}: invalid escalateConsecutive ${escalateConsecutive} — must be an integer >= 1`);
  }
  const hardCancelCooldownMs = config.hardCancelCooldownMs ?? DEFAULT_HARD_CANCEL_COOLDOWN_MS;
  if (!Number.isInteger(hardCancelCooldownMs) || hardCancelCooldownMs < 0) {
    throw new Error(`${PLUGIN_NAME}: invalid hardCancelCooldownMs ${hardCancelCooldownMs} — must be an integer >= 0`);
  }
  const driverBackoffMinutes = config.driverBackoffMinutes ?? DEFAULT_DRIVER_BACKOFF_MINUTES;
  if (!Array.isArray(driverBackoffMinutes) || driverBackoffMinutes.length === 0 || driverBackoffMinutes.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(`${PLUGIN_NAME}: invalid driverBackoffMinutes — must be a non-empty array of integers >= 1`);
  }
  const phrases = {
    gentle: config.phrases?.gentle ?? DEFAULT_PHRASES.gentle,
    repeat: config.phrases?.repeat ?? DEFAULT_PHRASES.repeat,
    hardCancel: config.phrases?.hardCancel ?? DEFAULT_PHRASES.hardCancel,
  };
  return { thresholds, maxAllowedRepeats, argumentsPreviewChars, include, exclude, phrases, escalateConsecutive, hardCancelCooldownMs, driverBackoffMinutes };
}

/** Substitute `{key}` placeholders with the corresponding reminder fields. */
function renderPhrase(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/**
 * Pure tool-pattern detector factory.
 * @param {object} cfg - normalized tool-plugin config.
 * @returns {{
 *   observe: ({name: string, arguments: unknown}) => {reminder: object|null, consecutive: number},
 *   reset: () => void,
 *   hashOf: (toolName: string, payload: unknown) => string,
 *   history: () => string[],
 * }}
 */
export function createToolDetector(cfg) {
  const config = validateConfig(cfg);
  const thresholds = config.thresholds;
  const thresholdSet = new Set(thresholds);
  const includePatterns = config.include.map(wildcardToRegExp);
  const excludePatterns = config.exclude.map(wildcardToRegExp);

  const detector = shared.createAgentLoopDetector(config.maxAllowedRepeats);
  let lastCycleFire = 0;

  /**
   * Reminder level for an occurrence/repetition count, or null. Firing is
   * bounded to the configured thresholds (parity with the base plugin): the
   * former `count > lastThreshold` clause made every call past the last
   * threshold inject another notice, so a long run flooded the context
   * instead of ending it.
   */
  function levelFor(count) {
    if (!thresholdSet.has(count)) return null;
    return count === thresholds[0] ? 'gentle' : 'repeat';
  }

  /** Whether a tool participates in detection (untracked: neither count nor reset). */
  function tracked(toolName) {
    if (includePatterns.length > 0 && !includePatterns.some((p) => p.test(toolName))) return false;
    return !excludePatterns.some((p) => p.test(toolName));
  }

  /**
   * Advance the sequence by one call. Returns the reminder to deliver (or
   * null) together with the trailing run length of this exact call, which the
   * escalation path needs even when no reminder fires.
   */
  function observe(exec) {
    if (!tracked(exec.name)) return { reminder: null, consecutive: 0 };
    const canonical = shared.canonicalizeArgs(exec.arguments);
    detector.registerStep(exec.name, exec.arguments);

    // Trailing run of calls identical to this one (>= 1), computed next to the
    // history it reads. Escalation gates on this, not on total occurrences.
    const hash = detector.hashOf(exec.name, exec.arguments);
    const historyIds = detector.history();
    let consecutive = 0;
    for (let i = historyIds.length - 1; i >= 0 && historyIds[i] === hash; i -= 1) consecutive += 1;

    // 1) Floyd's cycle finding on the recent state-id tail (period >= 2).
    const tail = detector.history().slice(-CYCLE_WINDOW);
    if (shared.detectCycle(tail)) {
      const period = shared.cyclePeriod(tail);
      if (period && period >= 2) {
        const repetitions = Math.floor(tail.length / period);
        const level = levelFor(repetitions);
        const historyLength = detector.history().length;
        if (level && historyLength - lastCycleFire >= period) {
          lastCycleFire = historyLength;
          return {
            reminder: {
              level,
              count: repetitions,
              period,
              toolName: exec.name,
              argumentsPreview: previewArguments(canonical, config.argumentsPreviewChars),
              consecutive,
            },
            consecutive,
          };
        }
      }
    }

    // 2) State hashing: occurrence count of this exact call in the history.
    const occurrences = detector.occurrences(exec.name, exec.arguments);
    const level = levelFor(occurrences);
    if (level) {
      return {
        reminder: {
          level,
          count: occurrences,
          period: 1,
          toolName: exec.name,
          argumentsPreview: previewArguments(canonical, config.argumentsPreviewChars),
          consecutive,
        },
        consecutive,
      };
    }
    return { reminder: null, consecutive };
  }

  /** Clear the sequence (called on user-message reset). */
  function reset() {
    detector.reset();
    lastCycleFire = 0;
  }

  // Expose the inner detector's hashOf/history: the escalation path
  // (consecutiveCount) reads them off the same object observe/reset live on.
  return { observe, reset, hashOf: detector.hashOf, history: detector.history };
}

/** Build a user reminder message with the plugin source, per plan §3.3. */
function buildReminderMessage(phrases, reminder) {
  const summary = `${reminder.toolName} × ${reminder.count}`;
  // `arguments` is an alias for `argumentsPreview`: phrases authored against
  // the base plugin's wording keep rendering the real payload.
  const values = { ...reminder, arguments: reminder.argumentsPreview };
  const text =
    reminder.level === 'gentle'
      ? renderPhrase(phrases.gentle, values)
      : renderPhrase(phrases.repeat, values);
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: `plugin:${PLUGIN_NAME}`, form: 'notice', summary },
  };
}

/** Build the hard-cancel reminder delivered via followup at the next turn. */
function buildHardCancelMessage(phrases, toolName, count) {
  const text = renderPhrase(phrases.hardCancel, { toolName, count });
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: `plugin:${PLUGIN_NAME}`, form: 'notice', summary: `hard loop × ${count}` },
  };
}

/**
 * Cordis host plugin entry point. Validates config fail-loud, keeps one
 * detector per agent in a WeakMap, stages one reminder per step in
 * `tools/post-execute` and prepends it to the messages of the next step in
 * `agent/pre-step`, then resets on a user or goal message there.
 */
export default function repeatPatternReminderPlugin(ctx, config) {
  const resolved = validateConfig(config);
  const detectors = new WeakMap();
  // agent -> { cooldownUntil: number, backoffIndex: number }
  const escalations = new WeakMap();
  // agent -> { injectedThisStep: boolean, staged: object|null }
  const stepStates = new WeakMap();

  function detectorFor(agent) {
    let detector = detectors.get(agent);
    if (!detector) {
      detector = createToolDetector(resolved);
      detectors.set(agent, detector);
    }
    return detector;
  }

  /**
   * Per-step state of one agent: at most one staged notice per step. A parallel
   * batch of identical calls is one step, so however many calls it contains it
   * produces a single notice.
   */
  function stepStateFor(agent, freshTurn = false) {
    let state = stepStates.get(agent);
    if (state === undefined || freshTurn) {
      state = { injectedThisStep: false, staged: null };
      stepStates.set(agent, state);
    }
    return state;
  }

  function escalationFor(agent) {
    let escalation = escalations.get(agent);
    if (!escalation) {
      escalation = { cooldownUntil: 0, backoffIndex: 0 };
      escalations.set(agent, escalation);
    }
    return escalation;
  }

  /**
   * Driver backoff: disarm the active armed goal so the goal-round driver
   * cannot fire a round while a looped model keeps burning them, then re-arm
   * it after an escalating window (2/5/15 min). Re-arm is guarded: only when
   * the same goal revision is still active-but-disarmed.
   */
  function applyDriverBackoff(agent, escalation) {
    const goals = ctx.get('goals');
    if (goals === undefined) return;
    let goal;
    try {
      goal = goals.get(agent);
    } catch {
      return;
    }
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return;
    const ref = { id: goal.id, revision: goal.revision };
    try {
      goals.disarm(agent);
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN_NAME}: could not disarm goal for agent "${agent.id}": ${String(error)}`);
      return;
    }
    const ladder = resolved.driverBackoffMinutes;
    const minutes = ladder[Math.min(escalation.backoffIndex, ladder.length - 1)];
    escalation.backoffIndex += 1;
    ctx.setTimeout(() => {
      try {
        const agents = ctx.get('agents');
        if (agents === undefined || agents.get(agent.id) !== agent) return;
        const latest = goals.get(agent);
        if (latest === undefined || latest.id !== ref.id || latest.revision !== ref.revision) return;
        if (latest.phase === 'active' && latest.activation === 'disarmed') goals.resume(agent, ref);
      } catch {
        // Re-arm is best-effort; a user message or the next session start
        // re-arms the goal through the existing driver/goal patches.
      }
    }, minutes * 60_000);
  }

  /** Stage a hard cancel for the next generation, then return true. */
  function stageHardCancel(agent, toolName, consecutive) {
    const escalation = escalationFor(agent);
    if (Date.now() < escalation.cooldownUntil) return false;
    const message = buildHardCancelMessage(resolved.phrases, toolName, consecutive);
    shared.markHardCancelPending(agent, message);
    escalation.cooldownUntil = Date.now() + resolved.hardCancelCooldownMs;
    applyDriverBackoff(agent, escalation);
    return true;
  }

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next();
    const agent = exec.agent;
    if (!agent) return downstream;
    const { reminder, consecutive } = detectorFor(agent).observe({ name: exec.name, arguments: exec.arguments });

    // Escalation is checked independently of the reminder thresholds: a long
    // run must reach the hard cancel even though the soft reminder stopped
    // firing at the last threshold. Once the run crosses the limit the batch
    // stays quiet — the cancel is armed and the next generation aborts.
    if (consecutive >= resolved.escalateConsecutive) {
      stageHardCancel(agent, exec.name, consecutive);
      return downstream;
    }
    if (!reminder) return downstream;

    // A staged hard cancel owns the rest of the batch: more soft reminders
    // would only burn context before the abort lands.
    if (shared.peekHardCancel(agent)) return downstream;

    const state = stepStateFor(agent);
    if (state.injectedThisStep) return downstream;

    // Coordination (read-and-clear): a thinking reminder already went in this step.
    const thinkingInjected = shared.wasThinkingInjected(agent);
    shared.clear(agent);
    if (thinkingInjected) return downstream;
    shared.markToolInjected(agent);

    // Stage, never inject per call: the notice leaves with the next step, so a
    // batch of 1001 identical calls adds one message instead of one per call.
    state.injectedThisStep = true;
    state.staged = buildReminderMessage(resolved.phrases, reminder);
    return downstream;
  });

  // Consume a staged hard cancel at the start of the next generation: the
  // steered message lands in next-step before the abort, and the resume path
  // of the dsh-agent-loop patch carries it into the running turn's next step.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'start') return;
    const message = shared.consumeHardCancel(agent);
    if (!message) return;
    detectorFor(agent).reset();
    // Steer BEFORE the cancel: the message lands in next-step before the
    // abort reclassifies it (a true steer, not the queue).
    agent.steer(message);
    // The abort ends the step: hand the next generation a fresh step state.
    stepStateFor(agent, true);
    agent.cancel(
      { kind: 'hook', reason: `${PLUGIN_NAME}:escalation` },
      { keepInbox: true },
    );
  });

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    // A goal round opens a turn of its own (`source.kind === 'goal'`, not
    // 'user'): for this plugin it is a fresh turn too, otherwise the detector
    // and the escalation ladder would carry state across autonomous rounds.
    const freshTurn = messages.some((m) => m.source?.kind === 'user' || m.source?.kind === 'goal');
    const state = stepStateFor(agent, freshTurn);
    // A notice staged while the previous step ran is delivered with THIS step:
    // one message per batch, painted next to the results it refers to. A fresh
    // turn drops it and resets the run detector and the escalation ladder.
    const staged = freshTurn ? null : state.staged;
    state.injectedThisStep = false;
    state.staged = null;
    if (freshTurn) {
      detectors.get(agent)?.reset();
      escalations.delete(agent);
      shared.clear(agent);
      shared.clearHardCancel(agent);
    }
    const decision = await next();
    if (staged === null) return decision;
    if (decision.kind !== 'enter') return decision;
    // An armed hard cancel owns the turn: a soft notice next to the abort is noise.
    if (shared.peekHardCancel(agent)) return decision;
    return { ...decision, messages: [staged, ...decision.messages] };
  });

  ctx.on('agent/disposed', ({ agent }) => {
    detectors.delete(agent);
    escalations.delete(agent);
    stepStates.delete(agent);
    shared.clear(agent);
  });
}