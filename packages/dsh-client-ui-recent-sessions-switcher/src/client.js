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
// unread), and a dropdown of the 8 most recently-updated sessions. Clicking an
// item opens that session via the `sessions` service. The currently-selected
// session is highlighted in the dropdown (business-colored label + trailing
// check icon, mirroring dsh's own Menu selected-item pattern).
//
// Status model mirrors dsh's StateDot:
//   - pending   -> "warning"  (orange, awaiting user input)
//   - running   -> "ongoing"  (animated matrix, DeepSeek brand blue #5686fe)
//   - completed -> "done"     (green, idle with unread output)
//   - else      -> "idle"     (transparent dot with silver outline)
// A session whose own loop is idle but whose subagent descendants are active
// renders as active too: "Working (subagents)" (ongoing) while any descendant
// runs, "Needs input (subagent)" (warning) while any descendant awaits input —
// the same priority order the badge uses (input outranks running).
//
// Green ("done") requires the session AND its entire subagent subtree to have
// finished: a parent whose loop ended while any of its subagents (transitively)
// are still running renders "Working (subagents)", not green. The badge's green
// is the same per-session gate, aggregated: it lights when SOME visible session
// is finished with unread output, and unrelated activity elsewhere no longer
// blocks it (a finished parent whose own subagents are still working still
// never turns the badge green). Orange (input) outranks green. The badge number
// reads the finished-unread count while green, else the total active count, so
// a green pill never shows "0".
//
// The `completed` heuristic in dsh intentionally stays false for the
// currently-selected session, so a session that finished while the window was
// unfocused would otherwise render as "idle, all read". We force the green
// ("unread") dot with a CSS class: armed the moment the window loses focus
// while the current session was still running, cleared on refocus. The class is
// applied only when the current session's subtree is finished, so a parent
// whose subagents are still working stays silver even while the window is
// unfocused. Note the selected session never receives server `completed`, so a
// selected parent whose subtree finishes while it stays selected renders idle
// until switched away (the forceUnread path covers only the window-blur case).
// `completed` is also in-memory server-side: a page reload loses unread
// reminders until a new session finishes while the page is open (mirrors dsh's
// own StateDot).
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

const statusOf = (s) => {
  if (s.pending) return { state: "warning", label: "Needs input" };
  if (s.running) return { state: "ongoing", label: "Working" };
  if (s.hasPendingDescendant) return { state: "warning", label: "Needs input (subagent)" };
  if (s.hasRunningDescendant) return { state: "ongoing", label: "Working (subagents)" };
  if (s.completed && s.finished) return { state: "done", label: "Idle, unread output" };
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
// non-archived) sessions that are both server-completed and finished — the
// exact set the badge's green lights for; unrelated activity elsewhere does not
// suppress it (the finished gate is per-session, not global).
const deriveActivity = (list, pendingInteractions, archivedSessionIds) => {
  const result = {
    running: 0, input: 0, unreadFinished: 0,
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
    const pending = visiblePendingKind(pendingInteractions.get(id)?.kind);
    if (pending && s.running === true) {
      if (isSubagent) result.inputSubagents++;
      else result.input++;
      pendingRunningSessions.push(s);
    } else if (s.running === true) {
      if (isSubagent) result.runningSubagents++;
      else result.running++;
    }
    if (s.running === true) runningSessions.push(s);
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
  // Finished-with-unread count: visible, non-archived, server-completed and
  // not running with no running descendant and no unattributed running.
  for (const id of list.ids) {
    const s = byId[id];
    if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
    if (s.completed !== true || s.running === true) continue;
    if (result.unattributedRunning || result.hasRunningDescendant.get(id)) continue;
    result.unreadFinished++;
  }
  return result;
};

// Pure badge view from the activity picture. Orange (input) outranks green;
// green lights when some visible session is finished with unread output; the
// number reads the finished-unread count while green (so a green pill never
// shows "0"), else the total active count. Both branches cap at "9+".
const badgeView = (activity) => {
  const { running, input, unreadFinished, runningSubagents, inputSubagents } = activity;
  const totalRunning = running + runningSubagents;
  const totalInput = input + inputSubagents;
  const totalActive = totalRunning + totalInput;
  const cls = "rss-badge" + (totalInput > 0 ? " rss-badgeWarn" : unreadFinished > 0 ? " rss-badgeUnread" : "");
  const title = [
    totalRunning > 0 ? totalRunning + " working" + (runningSubagents > 0 ? " (" + runningSubagents + " in subagents)" : "") : "",
    totalInput > 0 ? totalInput + " need" + (totalInput === 1 ? "s" : "") + " input" : "",
    unreadFinished > 0 ? unreadFinished + " finished with unread output" + (unreadFinished === 1 ? "" : "s") : ""
  ].filter(Boolean).join(", ");
  const shown = unreadFinished > 0 ? unreadFinished : totalActive;
  const number = shown > 10 ? "9+" : shown;
  return { cls, title, number };
};

// Pure dropdown cap: active/flagged sessions first, then the most recently
// updated others, capped at 8 — but the current session is always rendered,
// even when it falls outside the cap (a selected parent whose subagents are
// working must stay reachable and visible with its activity icon).
const capRecent = (items, sessionId) => {
  const priority = items.filter((i) => i.running || i.completed || i.pending || i.hasRunningDescendant || i.hasPendingDescendant);
  const rest = items.filter((i) => !i.running && !i.completed && !i.pending && !i.hasRunningDescendant && !i.hasPendingDescendant);
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
  if (status.state === "done") {
    return React.createElement("span", { className: "rss-dot", style: { background: "var(--dsw-alias-state-success-primary)" } });
  }
  return React.createElement("span", { className: "rss-dotSlot" },
    React.createElement("span", { className: "rss-dotIdle" })
  );
};

export const inject = ["slots", "sessions", "workspaces", "uiWorkspace"];

export function apply(ctx) {
  const slots = ctx.slots;
  const sessions = ctx.sessions;
  const workspaces = ctx.workspaces;
  const uiWorkspace = ctx.uiWorkspace;
  // One component serves two registrations: the header utilities row (active
  // Session) and the hero dock row (new Session). `heroDock` is injected by the
  // second registration so the trigger label can differ while the blank Session
  // has no title yet.
  const renderSwitcher = (props) => {
      const { useSessions, useSessionStatus, useWorkspaces, sessionId, heroDock } = props;
      const list = useSessions((s) => s);
      // dsh 0.1.7-rc.2 replaced the root `sessionPendingInteraction` hook with
      // `sessionStatus`; each entry carries the session's pending interaction.
      const status = useSessionStatus((s) => s);
      const pendingInteractions = React.useMemo(() => {
        const map = new Map();
        for (const [id, st] of status) map.set(id, st.pendingInteraction);
        return map;
      }, [status]);
      const workspaceSnapshot = useWorkspaces((s) => s);
      const archivedSessionIds = workspaceSnapshot.archivedSessionIds;
      const [open, setOpen] = React.useState(false);
      const [forceUnread, setForceUnread] = React.useState(false);
      const rootRef = React.useRef(null);
      const currentRunningRef = React.useRef(false);

      React.useEffect(() => {
        const onBlur = () => { if (currentRunningRef.current) setForceUnread(true); };
        const onFocus = () => setForceUnread(false);
        window.addEventListener("blur", onBlur);
        window.addEventListener("focus", onFocus);
        return () => {
          window.removeEventListener("blur", onBlur);
          window.removeEventListener("focus", onFocus);
        };
      }, []);

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
      // per-session "finished" predicate used to gate green on the trigger dot,
      // the dropdown rows and the forced-unread class.
      const activity = React.useMemo(
        () => deriveActivity(list, pendingInteractions, archivedSessionIds),
        [list, pendingInteractions, archivedSessionIds]
      );
      const finished = (s) => s !== undefined && s.running !== true && !activity.unattributedRunning && !activity.hasRunningDescendant.get(s.id);

      const recent = React.useMemo(() => {
        if (list.phase !== "ready") return [];
        const archived = new Set(archivedSessionIds);
        const items = [];
        for (const id of list.ids) {
          const s = list.byId[id];
          if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
          items.push({ id, title: s.displayTitle, workspace: workspaceLabelOf(s), cwd: s.cwd, updatedAt: s.updatedAt, running: s.running === true, completed: s.completed === true, pending: visiblePendingKind(pendingInteractions.get(id)?.kind), finished: finished(s), hasRunningDescendant: activity.hasRunningDescendant.get(id) === true, hasPendingDescendant: activity.hasPendingDescendant.get(id) === true });
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        // Always include every active (running), unread (completed),
        // input-requiring (pending), or descendant-active session; fill the
        // remaining slots up to 8 with the most recently-updated others. The
        // current session is always rendered even beyond the cap (see
        // capRecent). Within each group the sort above (by last-modified time)
        // is preserved.
        return capRecent(items, sessionId);
      }, [list, pendingInteractions, archivedSessionIds, workspaceBySession, activity, sessionId]);

      const current = list.byId[sessionId];
      currentRunningRef.current = current ? current.running === true : false;
      const currentFinished = finished(current);
      const currentTitle = current && !current.blank ? current.displayTitle : "";
      const currentWorkspace = current && current.cwd ? workspaceLabelOf(current) : "";
      const currentStatus = current
        ? statusOf({ running: current.running === true, completed: current.completed === true, pending: visiblePendingKind(pendingInteractions.get(sessionId)?.kind), finished: currentFinished, hasRunningDescendant: activity.hasRunningDescendant.get(sessionId) === true, hasPendingDescendant: activity.hasPendingDescendant.get(sessionId) === true })
        : { state: "idle", label: "Idle" };
      // Badge: total active agents (working or awaiting input) across ALL
      // sessions, including the current one and every running subagent. Orange
      // when any agent awaits input (outranks green); green when some visible
      // session is finished (its whole subtree done) with unread output —
      // unrelated activity elsewhere no longer blocks it, and a finished parent
      // whose own subagents are still working never turns the badge green. The
      // number reads the finished-unread count while green, else the total
      // active count (see badgeView).
      const badge = badgeView(activity);
      // On the hero dock the bound Session is blank, so there is no title to pair
      // the workspace with: drop the `cwd /` prefix rather than render
      // "dsh / Recent sessions" (the hero workspace chip already names it).
      const isHeroDock = heroDock === true;
      const showCwd = currentWorkspace !== "" && !(isHeroDock && currentTitle === "");
      // Hero screen with nothing to switch to: no control at all rather than an
      // inert trigger that reads "0". Safe to return here: every hook above has
      // already run and no hook follows.
      if (isHeroDock && recent.length === 0) return null;

      return React.createElement("div", { className: "rss-root" + (forceUnread && currentFinished ? " rss-forceUnread" : ""), ref: rootRef },
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
                          // without a current session (dsh clears the selection).
                          // Switch to the freshest remaining session, preferring
                          // a session in the same working directory; when none
                          // exists (or the archived session had no cwd), fall
                          // back to the freshest one overall.
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