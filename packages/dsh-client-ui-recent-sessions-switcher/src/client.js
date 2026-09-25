// Recent-sessions switcher — client half (source mirror of lib/client.js).
//
// This file is the readable source of the browser bundle. The shipped
// lib/client.js is the same code wrapped in the client-modules bundle format
// (window.__ModuleLoader__.load({ id, factory })) with `react` and
// `@deepseek-ai/dsh-client-ui-primitives` required from the platform seed.
// Keep the two in sync; lib/client.js is what the browser actually loads.
// All styling (the `css` array, including the hero-dock layout CSS that puts
// the hero trigger on the hero chip row) lives in lib/client.js only; this
// mirror carries the component logic.
//
// The plugin registers the same switcher twice: into
// `conversation.session.header.utilities` (a session-scoped list slot, active
// Session chrome) and into `conversation.input.dock` (the session-scoped list
// slot the hero composer stack renders above the prompt card), so the switcher
// also shows on the new-Session screen. Both render a compact switcher: the
// current session's workspace name + title, a status dot (running / idle /
// error / done), and a dropdown of the 8 most recently-updated sessions.
// Clicking an item opens that session via the `sessions` service. The
// currently-selected session is highlighted in the dropdown (business-colored
// label + trailing check icon, mirroring dsh's own Menu selected-item pattern).
//
// Status model mirrors dsh's StateDot:
//   - pending   -> "warning"  (orange, awaiting user input)
//   - running   -> "ongoing"  (animated matrix, DeepSeek brand blue #5686fe)
//   - done      -> "green"    (finished cleanly, not yet viewed)
//   - error     -> "red"      (last turn failed or was abandoned)
//   - else      -> "idle"     (transparent dot with silver outline)
// A session whose own loop is idle but whose subagent descendants are active
// renders as active too: "Working (subagents)" (ongoing) while any descendant
// runs, "Needs input (subagent)" (warning) while any descendant awaits input —
// the same priority order the badge uses (input outranks running).
//
// Red and green are derived from the session journal's tail, read through the
// session-controller remote (`projections` for the log cursor, then `page` for
// the last turn window). Red reports a session whose last turn is unfinished
// (a `turn/start` with no following `turn/end` while the session is not
// running — an abandoned turn) or whose last `turn/end` reason is `error` or
// `max-tokens`. Green reports a last `turn/end` reason of `completed`. Both
// require the session to be idle, exclude the currently-selected session, and
// clear once the session has been viewed (`acknowledged`, in-memory: added
// when the user leaves a session, deleted when it runs again, reset on page
// reload). `aborted` / `interrupted` turns are neither red nor green (silver).
// Because the state is journal-derived, a page reload recomputes it honestly
// from the journals (no localStorage).
//
// The journal reads are cached per session keyed by the list row's
// `updatedAt` plus the running-state transition (a run that just ended needs a
// fresh tail), so steady-state renders do not re-read. The badge aggregates
// per-session flags: orange (input) outranks red, red outranks green; the
// number reads the winning count (so a green pill never shows "0").
//
// One in-memory fallback remains: the host's `api-session/error` event for a
// session whose journal is empty (background-activation failure) marks it red
// until reload — there is no journal content to acknowledge. For sessions with
// content the same event only supplies a title message; the color comes from
// the journal.
//
// The dropdown always renders the current session, even when it falls outside
// the 8-slot cap: a selected parent whose subagents are working must stay
// reachable (and visible with its activity icon) no matter how many fresher
// sessions compete for the slots.
//
// Each dropdown row carries an archive action (the primitives archive glyph)
// that shares the trailing slot with the current-session check mark: the
// check shows at rest, and hovering the row swaps it for the archive glyph.
// Clicking the glyph calls the `workspaces` service's archiveSession.
// Archived sessions are excluded from the dropdown and the badge.

import { IconArchiveOutlineMedium, IconCheckOutlineMedium, IconClockOutlineMedium } from "@deepseek-ai/dsh-client-ui-primitives";

const workspaceTitleOf = (path) => {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1);
};

// In-memory registry of sessions whose last request failed, populated from the
// host's `api-session/error` event. For sessions with journal content it only
// supplies a title message (the color comes from the journal tail); for a
// session whose journal is empty (background-activation failure) it is the red
// source, kept until reload. Cleared when the session runs again or vanishes
// from the list. The two registrations (header + hero dock) share this single
// map and one subscription.
const sessionErrors = new Map();

// In-memory set of sessions whose final state the user has already seen: added
// when the user leaves a session (it was the current one, its content was on
// screen), deleted when the session runs again, reset on page reload. Mirrors
// dsh's own `completionUnread` lifetime, applied to both red and green.
const acknowledged = new Set();

// The last session id any registration rendered for. Module-level because the
// session-scoped header slot remounts its children on every session switch, so
// a per-instance ref would never see the session the user just left.
let lastSeenSessionId = undefined;

// Journal-tail cache: sessionId -> { updatedAt, state } where `state` is the
// derived tail described in `deriveTail`. `updatedAt` is the list row's value
// at read time; a mismatch triggers a re-read. Shared by both registrations.
const tailCache = new Map();

// Session ids whose tail read is currently in flight (dedupes the two
// registrations firing the same reads).
const tailInflight = new Set();

// Session ids whose first tail read failed and already retried once.
const tailRetried = new Set();

// Last observed running state per session (from list/status), used to detect
// the running -> idle transition that needs a fresh tail read.
const lastRunning = new Map();

// Re-render hooks: both component instances subscribe; a completed tail read
// bumps their state so the badge re-derives from the fresh cache.
const tailListeners = new Set();
const notifyTail = () => {
  for (const listener of tailListeners) listener();
};

// Pending-interaction kinds that dsh surfaces as the orange ("warning") dot.
const visiblePendingKind = (kind) => {
  if (kind === "approval" || kind === "plan-review" || kind === "question") return kind;
  return undefined;
};

// The most recently-updated visible session satisfying `predicate` (every
// visible session when omitted), excluding `excludeId`. Used to auto-switch
// the switcher when the current session is archived (dsh clears the
// selection; we land on the freshest remaining one, preferring the same
// working directory).
const freshestVisibleSessionId = (list, archived, excludeId, predicate) => {
  if (list.phase !== "ready") return undefined;
  const archivedSet = new Set(archived);
  let bestId;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const id of list.ids) {
    if (id === excludeId) continue;
    const s = list.byId[id];
    if (s === undefined || s.blank || s.origin === "subagent" || archivedSet.has(id)) continue;
    if (predicate !== undefined && !predicate(s)) continue;
    const t = s.updatedAt;
    if (t > bestTime) { bestTime = t; bestId = id; }
  }
  return bestId;
};

// Derive the tail state of a session from one backwards page of its journal
// (records arrive in forward order, so the scan runs from the end). Only the
// last turn matters:
//   - the last `turn/end` (if any) fixes `lastEndKind` / `lastError`;
//   - a `turn/start` after the last `turn/end` means the last turn is open;
//   - a window full of messages with no turn boundary at all means the last
//     turn is open and longer than the window (its start lies further back).
//
// The server balances a journal that ends inside an open turn with synthetic
// `step/end` + `turn/end` closers (reason `interrupted`) that all share the
// last real event's timestamp (see `openTurnClosers` in dsh-session). A real
// interrupted turn/end carries its own later time, so an `interrupted` closer
// stamped with the previous record's time is the signature of an abandoned
// (open) turn — treat it as open.
const deriveTail = (records) => {
  let lastStartSeq = -1;
  let lastEndSeq = -1;
  let lastEndKind;
  let lastError;
  let sawMessage = false;
  let lastTime;
  let prevTime;
  for (let i = records.length - 1; i >= 0; i--) {
    const event = records[i]?.event;
    if (event === undefined) continue;
    if (lastTime === undefined) lastTime = event.time;
    else if (prevTime === undefined) prevTime = event.time;
    if (event.type === "turn/start") {
      if (lastStartSeq === -1) lastStartSeq = event.seq;
    } else if (event.type === "turn/end") {
      if (lastEndSeq === -1) {
        lastEndSeq = event.seq;
        lastEndKind = event.data?.reason?.kind;
        const error = event.data?.reason?.error;
        if (error !== undefined && typeof error.message === "string" && error.message.trim() !== "") lastError = error.message;
      }
    } else if (event.type === "user/message" || event.type === "assistant/message") {
      sawMessage = true;
    }
  }
  const syntheticCloser = lastEndKind === "interrupted" && lastTime !== undefined && lastTime === prevTime;
  return {
    hasTurns: lastStartSeq >= 0,
    hasContent: lastStartSeq >= 0 || sawMessage,
    openTurn: (lastStartSeq > lastEndSeq || (sawMessage && lastStartSeq === -1 && lastEndSeq === -1)) || syntheticCloser,
    lastEndKind,
    lastError
  };
};

// Read one session's journal tail through the session-controller remote:
// `projections` yields the log cursor (asOfSeq), then `page` returns the last
// turn window. The result lands in `tailCache`; a failure drops the entry and
// retries once (a later list/status change re-fires the read anyway).
const readTail = async (remote, sessionId, updatedAt) => {
  try {
    const projections = await remote.session.projections({ sessionId });
    if (!projections.ok) throw projections.error;
    const baseline = projections.value;
    if (baseline === null || baseline === undefined || baseline.asOfSeq < 0) {
      tailCache.set(sessionId, { updatedAt, state: { hasTurns: false, hasContent: false, openTurn: false, lastEndKind: undefined, lastError: undefined } });
      return;
    }
    const page = await remote.session.page({
      address: { kind: "session", sessionId },
      throughSeq: baseline.asOfSeq,
      maxMessages: 50,
      turnWindow: { minMessages: 1, minTurns: 1 }
    });
    if (!page.ok) throw page.error;
    tailCache.set(sessionId, { updatedAt, state: deriveTail(page.value.records) });
    tailRetried.delete(sessionId);
  } catch (error) {
    tailCache.delete(sessionId);
    if (!tailRetried.has(sessionId)) {
      tailRetried.add(sessionId);
      setTimeout(() => {
        if (tailCache.has(sessionId)) return;
        tailInflight.add(sessionId);
        readTail(remote, sessionId, updatedAt);
      }, 1500);
    }
  } finally {
    tailInflight.delete(sessionId);
    notifyTail();
  }
};

// Per-session red/green flag from the journal tail plus the in-memory
// registers. Returns { flag: "red" | "green", message? } or undefined for
// silver (idle, aborted/interrupted, running, the current session, or a
// viewed session). `message` carries the error text for the red pill title.
const sessionFlag = (s, status, sessionId) => {
  if (s === undefined || s.id === sessionId) return undefined;
  const running = status?.running ?? (s.running === true);
  if (running) return undefined;
  if (s.blank) {
    const message = sessionErrors.get(s.id);
    return message !== undefined ? { flag: "red", message } : undefined;
  }
  const tail = tailCache.get(s.id)?.state;
  const contentRed = tail !== undefined && (tail.openTurn || tail.lastEndKind === "error" || tail.lastEndKind === "max-tokens");
  const fallbackRed = (tail === undefined || !tail.hasContent) && sessionErrors.has(s.id);
  if (contentRed && !acknowledged.has(s.id)) return { flag: "red", message: tail.lastError ?? sessionErrors.get(s.id) };
  if (fallbackRed) return { flag: "red", message: sessionErrors.get(s.id) };
  if (tail !== undefined && tail.lastEndKind === "completed" && !acknowledged.has(s.id)) return { flag: "green" };
  return undefined;
};

const statusOf = (s) => {
  if (s.pending) return { state: "warning", label: "Needs input" };
  if (s.running) return { state: "ongoing", label: "Working" };
  if (s.hasPendingDescendant) return { state: "warning", label: "Needs input (subagent)" };
  if (s.hasRunningDescendant) return { state: "ongoing", label: "Working (subagents)" };
  if (s.errored && s.finished) return { state: "error", label: "Last request failed" };
  if (s.completed && s.finished) return { state: "done", label: "Done, unread" };
  return { state: "idle", label: "Idle, all read" };
};

// Total active-agent picture across ALL sessions (visible and subagent of any
// parent, archived included — archiving does not stop an agent) plus, per
// session, whether a running or input-awaiting descendant exists. A session is
// "finished" only when it is not running and none of its subagent descendants
// (transitively) are running; green is reserved for that state, so a parent
// whose subagents are still working never turns green. One session = at most
// one active agent: an agent paused on a question/approval keeps its loop phase
// "running", so it counts under input only — and pending counts only for a
// running agent (a stopped agent leaves a stale pending interaction behind). A
// running session whose parent is missing from the registry cannot be
// attributed to any ancestor, so no session is then treated as finished (its
// green would be a lie). `unreadFinished` counts visible (non-subagent,
// non-archived) sessions that are journal-derived green (finished cleanly, not
// yet viewed); `errored` counts journal-derived red (failed or abandoned last
// turn, or an activation failure with an empty journal). Running state prefers
// the live `sessionStatus` value over the list row (dsh's own workspace
// browser does the same).
const deriveActivity = (list, statuses, archivedSessionIds, sessionId) => {
  const result = {
    running: 0, input: 0, unreadFinished: 0, errored: 0, firstError: undefined,
    runningSubagents: 0, inputSubagents: 0,
    hasRunningDescendant: new Map(),
    hasPendingDescendant: new Map(),
    unattributedRunning: false
  };
  if (list.phase !== "ready") return result;
  const byId = list.byId;
  const archived = new Set(archivedSessionIds);
  const runningSessions = [];
  const pendingRunningSessions = [];
  for (const id of list.ids) {
    const s = byId[id];
    if (s === undefined || s.blank) continue;
    const isSubagent = s.origin === "subagent";
    const status = statuses.get(id);
    const running = status?.running ?? (s.running === true);
    const pending = visiblePendingKind(status?.pendingInteraction?.kind);
    if (pending && running) {
      if (isSubagent) result.inputSubagents++;
      else result.input++;
      pendingRunningSessions.push(s);
    } else if (running) {
      if (isSubagent) result.runningSubagents++;
      else result.running++;
    }
    if (running) runningSessions.push(s);
  }
  // Mark every ancestor of a running session as "has a running descendant".
  for (const s of runningSessions) {
    let cur = s;
    while (cur.parentId !== undefined) {
      const parentId = cur.parentId;
      const parent = byId[parentId];
      if (parent === undefined) { result.unattributedRunning = true; break; }
      if (result.hasRunningDescendant.has(parentId)) break;
      result.hasRunningDescendant.set(parentId, true);
      cur = parent;
    }
  }
  // Mark every ancestor of an input-awaiting (pending && running) session as
  // "has a pending descendant" — a subset of the running walk above, kept
  // separate so the parent renders "Needs input (subagent)" rather than
  // "Working (subagents)".
  for (const s of pendingRunningSessions) {
    let cur = s;
    while (cur.parentId !== undefined) {
      const parentId = cur.parentId;
      const parent = byId[parentId];
      if (parent === undefined) break;
      if (result.hasPendingDescendant.has(parentId)) break;
      result.hasPendingDescendant.set(parentId, true);
      cur = parent;
    }
  }
  // Red/green count: visible, non-archived sessions whose journal tail flags
  // them (see sessionFlag), excluding the current session and any session
  // whose subtree is still active. `firstError` carries the first error
  // message for the red pill's title.
  for (const id of list.ids) {
    const s = byId[id];
    if (s === undefined || s.origin === "subagent" || archived.has(id)) continue;
    if (result.unattributedRunning || result.hasRunningDescendant.get(id)) continue;
    const flag = sessionFlag(s, statuses.get(id), sessionId);
    if (flag === undefined) continue;
    if (flag.flag === "red") {
      result.errored++;
      if (result.firstError === undefined && flag.message !== undefined && flag.message.trim() !== "") result.firstError = flag.message.length > 200 ? flag.message.slice(0, 200) + "…" : flag.message;
    } else {
      result.unreadFinished++;
    }
  }
  return result;
};

// Pure badge view from the activity picture. Orange (input) outranks red
// (failed last request), which outranks green (done); the number reads the
// winning count (so a green pill never shows "0"), else the total active
// count. Both branches cap at "9+".
const badgeView = (activity) => {
  const { running, input, unreadFinished, errored, runningSubagents, inputSubagents, firstError } = activity;
  const totalRunning = running + runningSubagents;
  const totalInput = input + inputSubagents;
  const totalActive = totalRunning + totalInput;
  const cls = "rss-badge" + (totalInput > 0 ? " rss-badgeWarn" : errored > 0 ? " rss-badgeError" : unreadFinished > 0 ? " rss-badgeUnread" : "");
  const title = [
    totalRunning > 0 ? totalRunning + " working" + (runningSubagents > 0 ? " (" + runningSubagents + " in subagents)" : "") : "",
    totalInput > 0 ? totalInput + " need" + (totalInput === 1 ? "s" : "") + " input" : "",
    errored > 0 ? errored + " failed last request" + (errored === 1 ? "" : "s") + (firstError !== undefined ? ", Last error: " + firstError : "") : "",
    unreadFinished > 0 ? unreadFinished + " finished with unread output" + (unreadFinished === 1 ? "" : "s") : ""
  ].filter(Boolean).join(", ");
  const shown = totalInput > 0 ? totalActive : errored > 0 ? errored : unreadFinished > 0 ? unreadFinished : totalActive;
  const number = shown > 10 ? "9+" : shown;
  return { cls, title, number };
};

// Pure dropdown cap: active/flagged sessions first (running, input-requiring,
// descendant-active, or red — red needs attention and stays reachable), then
// the most recently-updated others, capped at 8 — but the current session is
// always rendered, even when it falls outside the cap (a selected parent whose
// subagents are working must stay reachable and visible with its activity
// icon). Green sessions are recent by nature (they just finished) and reach
// the cap through the recency sort.
const capRecent = (items, sessionId) => {
  const priority = items.filter((i) => i.running || i.errored || i.pending || i.hasRunningDescendant || i.hasPendingDescendant);
  const rest = items.filter((i) => !i.running && !i.errored && !i.pending && !i.hasRunningDescendant && !i.hasPendingDescendant);
  const restCapped = rest.slice(0, Math.max(0, 8 - priority.length));
  const currentItem = items.find((i) => i.id === sessionId);
  if (currentItem !== undefined && !priority.includes(currentItem) && !restCapped.includes(currentItem)) restCapped.push(currentItem);
  return priority.concat(restCapped);
};

const StatusIndicator = ({ status }) => {
  if (status.state === "ongoing") {
    const cells = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]];
    return React.createElement("svg", { className: "rss-matrix", width: 10, height: 10, viewBox: "0 0 10 10", shapeRendering: "crispEdges", "aria-hidden": "true" },
      cells.map(([x, y], c) => React.createElement("rect", { key: c, x, y, width: 2, height: 2 }))
    );
  }
  if (status.state === "warning") {
    return React.createElement("span", { className: "rss-dot", style: { background: "var(--dsw-alias-state-warn-primary)" } });
  }
  if (status.state === "error") {
    return React.createElement("span", { className: "rss-dot", style: { background: "var(--dsw-alias-state-error-primary)" } });
  }
  if (status.state === "done") {
    return React.createElement("span", { className: "rss-dot", style: { background: "var(--dsw-alias-state-success-primary)" } });
  }
  return React.createElement("span", { className: "rss-dotSlot" },
    React.createElement("span", { className: "rss-dotIdle" })
  );
};

export const inject = ["slots", "sessions", "workspaces", "uiWorkspace", "remote", "remote.session"];

export function apply(ctx) {
  const slots = ctx.slots;
  const sessions = ctx.sessions;
  const workspaces = ctx.workspaces;
  const uiWorkspace = ctx.uiWorkspace;
  const remote = ctx.remote;
  // One subscription feeds both registrations: the host emits
  // `api-session/error(sessionId, message)` on agent-loop uncontained errors
  // (including LLM request failures) and on background-activation failures.
  // For sessions with journal content the color comes from the journal tail;
  // the event here only supplies the title message (and the red source for
  // the empty-journal activation-failure case).
  ctx.effect(() => {
    if (remote === undefined || typeof remote.$on !== "function") return;
    return remote.$on("api-session/error", (sessionId, message) => {
      if (typeof sessionId === "string" && typeof message === "string") sessionErrors.set(sessionId, message);
    });
  });
  // One component serves two registrations: the header utilities row (active
  // Session) and the hero dock row (new Session). `heroDock` is injected by the
  // second registration so the trigger label can differ while the blank Session
  // has no title yet.
  const renderSwitcher = (props) => {
      const { useSessions, useSessionStatus, useWorkspaces, sessionId, heroDock } = props;
      const list = useSessions((s) => s);
      // dsh 0.1.7-rc.2 replaced the root `sessionPendingInteraction` hook with
      // `sessionStatus`; each entry carries the session's pending interaction
      // and live running state. `completionUnread` is no longer used: green is
      // journal-derived now.
      const status = useSessionStatus((s) => s);
      const workspaceSnapshot = useWorkspaces((s) => s);
      const archivedSessionIds = workspaceSnapshot.archivedSessionIds;
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);

      // Re-render whenever a tail read lands in the shared cache (both
      // registrations subscribe; the read effect itself runs on list/status
      // changes and does not depend on this tick, so there is no loop).
      const [tailsTick, setTailsTick] = React.useState(0);
      React.useEffect(() => {
        const bump = () => setTailsTick((t) => t + 1);
        tailListeners.add(bump);
        return () => { tailListeners.delete(bump); };
      }, []);

      // Acknowledging: leaving a session means its final state was on screen,
      // so its red/green clears. The current session is excluded by id anyway;
      // this covers the session the user just left. Blank sessions have
      // nothing to acknowledge. `lastSeenSessionId` is module-level because
      // the session-scoped header slot remounts its children on every session
      // switch, which would reset a per-instance ref before it could fire.
      React.useEffect(() => {
        const prev = lastSeenSessionId;
        lastSeenSessionId = sessionId;
        if (prev === undefined || prev === sessionId) return;
        const prevSession = list.byId[prev];
        if (prevSession !== undefined && !prevSession.blank) acknowledged.add(prev);
      }, [sessionId, list]);

      // Register hygiene: a session that runs again is no longer failed or
      // viewed (its previous outcome is moot), and a session that vanished
      // from the list cannot stay flagged. Runs on every status/list change.
      React.useEffect(() => {
        for (const [id, st] of status) {
          if (st?.running === true) {
            sessionErrors.delete(id);
            acknowledged.delete(id);
          }
        }
        if (list.phase === "ready") {
          for (const id of sessionErrors.keys()) {
            if (!(id in list.byId)) sessionErrors.delete(id);
          }
          for (const id of acknowledged.keys()) {
            if (!(id in list.byId)) acknowledged.delete(id);
          }
        }
      }, [status, list]);

      // Journal-tail reads: for every visible non-blank session that is not
      // currently running, read the tail when it is new, its `updatedAt`
      // changed, or it just stopped running (a run that ended needs the final
      // turn). Running sessions are skipped — their tail is mid-turn and the
      // red/green gates exclude them anyway; the stop transition re-reads.
      React.useEffect(() => {
        if (list.phase !== "ready" || remote === undefined || remote.session === undefined) return;
        const archived = new Set(archivedSessionIds);
        const toRead = [];
        for (const id of list.ids) {
          const s = list.byId[id];
          if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
          const running = status.get(id)?.running ?? (s.running === true);
          const wasRunning = lastRunning.get(id);
          lastRunning.set(id, running);
          if (running) continue;
          const cached = tailCache.get(id);
          if (cached !== undefined && cached.updatedAt === s.updatedAt && wasRunning !== true) continue;
          if (tailInflight.has(id)) continue;
          toRead.push(id);
        }
        for (const id of toRead) {
          tailInflight.add(id);
          readTail(remote, id, list.byId[id].updatedAt);
        }
      }, [list, status, archivedSessionIds]);

      React.useEffect(() => {
        if (!open) return;
        const onDocClick = (e) => {
          if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDocClick);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDocClick);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      // Workspace display name for a session: the Workspace's user-chosen
      // `title` when the session is accounted to one (the title may differ from
      // the directory basename), otherwise the cwd basename. Mirrors dsh's own
      // resolution (workspace browser search rows, hero workspace chip).
      const workspaceBySession = React.useMemo(() => {
        const map = new Map();
        for (const workspace of workspaceSnapshot.items) {
          for (const sessionId of workspace.sessionIds) {
            if (!map.has(sessionId)) map.set(sessionId, workspace.title);
          }
        }
        return map;
      }, [workspaceSnapshot.items]);
      const workspaceLabelOf = (s) => workspaceBySession.get(s.id) ?? workspaceTitleOf(s.cwd);

      // Active-agent picture across all sessions (see deriveActivity) and the
      // per-session "finished" predicate used to gate green on the trigger dot
      // and the dropdown rows. Running state prefers the live `sessionStatus`
      // value over the list row (dsh's own workspace browser does the same).
      const activity = React.useMemo(
        () => deriveActivity(list, status, archivedSessionIds, sessionId),
        [list, status, archivedSessionIds, tailsTick, sessionId]
      );
      const runningOf = (s) => s !== undefined && (status.get(s.id)?.running ?? (s.running === true));
      const finished = (s) => s !== undefined && !runningOf(s) && !activity.unattributedRunning && !activity.hasRunningDescendant.get(s.id);

      const recent = React.useMemo(() => {
        if (list.phase !== "ready") return [];
        const archived = new Set(archivedSessionIds);
        const items = [];
        for (const id of list.ids) {
          const s = list.byId[id];
          if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
          // A session whose journal holds only the title event (no turns, no
          // messages) is blank in practice even though the server list reports
          // `blank: false` (the title counts as content). Exclude it from the
          // dropdown — except the current session, which stays reachable.
          const tailState = tailCache.get(id)?.state;
          if (id !== sessionId && tailState !== undefined && !tailState.hasContent) continue;
          const flag = sessionFlag(s, status.get(id), sessionId);
          items.push({ id, title: s.displayTitle, workspace: workspaceLabelOf(s), cwd: s.cwd, updatedAt: s.updatedAt, running: runningOf(s), completed: flag?.flag === "green", errored: flag?.flag === "red", pending: runningOf(s) ? visiblePendingKind(status.get(id)?.pendingInteraction?.kind) : undefined, finished: finished(s), hasRunningDescendant: activity.hasRunningDescendant.get(id) === true, hasPendingDescendant: activity.hasPendingDescendant.get(id) === true });
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        // Always include every active (running), input-requiring (pending),
        // descendant-active, or red session; fill the remaining slots up to 8
        // with the most recently-updated others. The current session is always
        // rendered even beyond the cap (see capRecent). Within each group the
        // sort above (by last-modified time) is preserved.
        return capRecent(items, sessionId);
      }, [list, status, archivedSessionIds, workspaceBySession, activity, sessionId]);

      const current = list.byId[sessionId];
      const currentFinished = finished(current);
      const currentTitle = current && !current.blank ? current.displayTitle : "";
      const currentWorkspace = current && current.cwd ? workspaceLabelOf(current) : "";
      // The current session is never red or green (its content is on screen):
      // its dot reports live activity only.
      const currentStatus = current
        ? statusOf({ running: runningOf(current), completed: false, errored: false, pending: runningOf(current) ? visiblePendingKind(status.get(sessionId)?.pendingInteraction?.kind) : undefined, finished: currentFinished, hasRunningDescendant: activity.hasRunningDescendant.get(sessionId) === true, hasPendingDescendant: activity.hasPendingDescendant.get(sessionId) === true })
        : { state: "idle", label: "Idle" };
      // Badge: total active agents (working or awaiting input) across ALL
      // sessions, including the current one and every running subagent. Orange
      // when any agent awaits input (outranks green); red when some visible
      // session's journal tail failed or was abandoned; green when some
      // visible session finished cleanly with unread output — unrelated
      // activity elsewhere no longer blocks it, and a finished parent whose
      // own subagents are still working never turns the badge green. The
      // number reads the winning count (see badgeView).
      const badge = badgeView(activity);
      // On the hero dock the bound Session is blank, so there is no title to pair
      // with the workspace: drop the `cwd /` prefix rather than render
      // "dsh / Recent sessions" (the hero workspace chip already names it).
      const isHeroDock = heroDock === true;
      const showCwd = currentWorkspace !== "" && !(isHeroDock && currentTitle === "");
      // Hero screen with nothing to switch to: no control at all rather than an
      // inert trigger that reads "0". Safe to return here: every hook above has
      // already run and no hook follows.
      if (isHeroDock && recent.length === 0) return null;

      return React.createElement("div", { className: "rss-root", ref: rootRef },
        React.createElement("button", {
          type: "button",
          className: "rss-trigger",
          onClick: () => setOpen((v) => !v),
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          title: isHeroDock ? "Recent sessions" : currentStatus.label,
        },
          // The status dot reports the bound Session's state; no Session is bound
          // on the hero screen, so a clock icon stands in and the trigger reads
          // as one of the hero chips.
          isHeroDock
            ? React.createElement(IconClockOutlineMedium, { size: 14 })
            : React.createElement(StatusIndicator, { status: currentStatus }),
          showCwd ? React.createElement("span", { className: "rss-cwd" }, currentWorkspace) : null,
          showCwd ? React.createElement("span", { className: "rss-cwdSep" }, "/") : null,
          React.createElement("span", { className: "rss-triggerLabel", title: isHeroDock ? "Recent sessions" : undefined }, currentTitle || (isHeroDock ? "Recent" : "Switch")),
          React.createElement("span", { className: "rss-chevron" }, open ? "\u25B2" : "\u25BC"),
          React.createElement("span", { className: badge.cls, title: badge.title }, badge.number)
        ),
        open && React.createElement("div", { className: "rss-menu", role: "listbox" },
          recent.length === 0
            ? React.createElement("div", { className: "rss-empty" }, "No sessions")
            : recent.map((item) => {
                const st = statusOf(item);
                return React.createElement("div", {
                  key: item.id,
                  role: "option",
                  className: "rss-item" + (item.id === sessionId ? " rss-current" : ""),
                },
                  React.createElement("button", {
                    type: "button",
                    className: "rss-itemMain",
                    onClick: () => { uiWorkspace.openSession(item.id); setOpen(false); },
                    title: st.label,
                  },
                    React.createElement(StatusIndicator, { status: st }),
                    item.workspace ? React.createElement("span", { className: "rss-itemCwd" }, item.workspace) : null,
                    item.workspace ? React.createElement("span", { className: "rss-itemCwdSep" }, "/") : null,
                    React.createElement("span", { className: "rss-itemLabel" }, item.title)
                  ),
                  React.createElement("div", { className: "rss-itemTrailing" },
                    item.id === sessionId ? React.createElement("span", { className: "rss-currentCheck" }, React.createElement(IconCheckOutlineMedium, { size: 16 })) : null,
                    React.createElement("button", {
                      type: "button",
                      className: "rss-itemArchive",
                      "aria-label": "Archive " + item.title,
                      title: "Archive session",
                      onClick: (e) => {
                        setOpen(false);
                        workspaces.archiveSession(item.id).then(() => {
                          // Archiving the current session leaves the switcher
                          // without a current session (dsh clears the
                          // selection). Switch to the freshest remaining
                          // session, preferring a session in the same working
                          // directory; when none exists (or the archived
                          // session had no cwd), fall back to the freshest one
                          // overall.
                          if (item.id === sessionId) {
                            const archivedCwd = item.cwd;
                            let target = undefined;
                            if (archivedCwd) {
                              target = freshestVisibleSessionId(list, archivedSessionIds, item.id, (s) => s.cwd === archivedCwd);
                            }
                            if (target === undefined) target = freshestVisibleSessionId(list, archivedSessionIds, item.id);
                            if (target !== undefined) uiWorkspace.openSession(target);
                          }
                        }).catch((reason) => {
                          console.warn("session archive rejected:", reason);
                        });
                      },
                    },
                      React.createElement(IconArchiveOutlineMedium, { size: 16 })
                    )
                  )
                );
              })
        )
      );
    }
  // The new-Session ("hero") screen renders the header - and with it every
  // `conversation.session.header.*` slot - empty: dsh hides the header chrome
  // while the bound Session is blank and renders no header at all when none is
  // selected. `conversation.input.dock` is the list slot the hero composer
  // stack renders directly above the prompt card, so the same switcher mounts
  // there for the new-Session screen. Visibility is decided by CSS off dsh's
  // stable `data-phase` root attribute, so the dock instance only shows while
  // the phase is `hero` and does not duplicate the header one afterwards.
  const renderHeroDock = (props) => React.createElement(
    "div",
    { className: "rss-heroDock" },
    React.createElement(renderSwitcher, props)
  );
  slots.inject("conversation.session.header.utilities", () => slots.register(
    { name: "conversation.session.header.utilities", id: "recent-sessions-switcher", order: -20 },
    renderSwitcher
  ));
  slots.inject("conversation.input.dock", () => slots.register(
    {
      name: "conversation.input.dock",
      id: "recent-sessions-switcher-hero",
      order: -20,
      inject: () => ({ heroDock: true })
    },
    renderHeroDock
  ));
}