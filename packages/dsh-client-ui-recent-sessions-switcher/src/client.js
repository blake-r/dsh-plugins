// Recent-sessions switcher — client half (source mirror of lib/client.js).
//
// This file is the readable source of the browser bundle. The shipped
// lib/client.js is the same code wrapped in the client-modules bundle format
// (window.__ModuleLoader__.load({ id, factory })) with `react` and
// `@deepseek-ai/dsh-client-ui-primitives` required from the platform seed.
// Keep the two in sync; lib/client.js is what the browser actually loads.
//
// The plugin registers into the `conversation.session.header.utilities` slot
// (a session-scoped list slot) and renders a compact switcher: the current
// session's workspace basename + title, a status dot (running / idle / unread),
// and a dropdown of the 8 most recently-updated sessions. Clicking an item
// opens that session via the `sessions` service. The currently-selected
// session is highlighted in the dropdown (business-colored label + trailing
// check icon, mirroring dsh's own Menu selected-item pattern).
//
// Status model mirrors dsh's StateDot:
//   - running   -> "ongoing"  (animated matrix, DeepSeek brand blue #5686fe)
//   - completed -> "done"     (green, idle with unread output)
//   - else      -> "idle"     (transparent dot with silver outline)
//
// The `completed` heuristic in dsh intentionally stays false for the
// currently-selected session, so a session that finished while the window was
// unfocused would otherwise render as "idle, all read". We force the green
// ("unread") dot with a CSS class: armed the moment the window loses focus
// while the current session was still running, cleared on refocus.
//
// Each dropdown row carries an archive action (the primitives archive glyph)
// that shares the trailing slot with the current-session check mark: the
// check shows at rest, and hovering the row swaps it for the archive glyph.
// Clicking the glyph calls the `workspaces` service's archiveSession.
// Archived sessions are excluded from the dropdown and the badge.

import { IconArchiveOutline20, IconCheckOutline16 } from "@deepseek-ai/dsh-client-ui-primitives";

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

// The most recently-updated session that stays visible once `excludeId` is
// archived. Used to auto-switch the switcher when the current session is
// archived (dsh clears the selection; we land on the freshest remaining one).
const freshestSessionId = (list, archived, excludeId) => {
  if (list.phase !== "ready") return undefined;
  const archivedSet = new Set(archived);
  let bestId;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const id of list.ids) {
    if (id === excludeId) continue;
    const s = list.byId[id];
    if (s === undefined || s.blank || s.origin === "subagent" || archivedSet.has(id)) continue;
    const t = s.updatedAt;
    if (t > bestTime) { bestTime = t; bestId = id; }
  }
  return bestId;
};

const statusOf = (s) => {
  if (s.pending) return { state: "warning", label: "Needs input" };
  if (s.running) return { state: "ongoing", label: "Working" };
  if (s.completed) return { state: "done", label: "Idle, unread output" };
  return { state: "idle", label: "Idle, all read" };
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

export const inject = ["slots", "sessions", "workspaces"];

export function apply(ctx) {
  const slots = ctx.slots;
  const sessions = ctx.sessions;
  const workspaces = ctx.workspaces;
  const renderSwitcher = (props) => {
      const { useSessions, useSessionPendingInteraction, useWorkspaces, sessionId } = props;
      const list = useSessions((s) => s);
      const pendingInteractions = useSessionPendingInteraction((s) => s);
      const archivedSessionIds = useWorkspaces((s) => s.archivedSessionIds);
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

      const recent = React.useMemo(() => {
        if (list.phase !== "ready") return [];
        const archived = new Set(archivedSessionIds);
        const items = [];
        for (const id of list.ids) {
          const s = list.byId[id];
          if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
          items.push({ id, title: s.displayTitle, cwd: s.cwd, updatedAt: s.updatedAt, running: s.running === true, completed: s.completed === true, pending: visiblePendingKind(pendingInteractions.get(id)?.kind) });
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        // Always include every active (running), unread (completed), or
        // input-requiring (pending) session; fill the remaining slots up to 8
        // with the most recently-updated others. Within each group the sort
        // above (by last-modified time) is preserved.
        const priority = items.filter((i) => i.running || i.completed || i.pending);
        const rest = items.filter((i) => !i.running && !i.completed && !i.pending);
        return priority.concat(rest).slice(0, 8);
      }, [list, pendingInteractions, archivedSessionIds]);

      const current = list.byId[sessionId];
      currentRunningRef.current = current ? current.running === true : false;
      const currentTitle = current && !current.blank ? current.displayTitle : "";
      const currentCwd = current && current.cwd ? workspaceTitleOf(current.cwd) : "";
      const currentStatus = current
        ? statusOf({ running: current.running === true, completed: current.completed === true, pending: visiblePendingKind(pendingInteractions.get(sessionId)?.kind) })
        : { state: "idle", label: "Idle" };
      // Badge: total active agents (working or awaiting input) across ALL
      // sessions, including the current one. Orange when any agent awaits
      // input (outranks green); green when any idle agent has unread output.
      const badge = React.useMemo(() => {
        if (list.phase !== "ready") return { count: 0, running: 0, input: 0, unread: 0 };
        const archived = new Set(archivedSessionIds);
        let running = 0, input = 0, unread = 0;
        for (const id of list.ids) {
          const s = list.byId[id];
          if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
          // One session = at most one active agent. An agent paused on a
          // question/approval keeps the loop phase "running", so it must be
          // counted under `input` only — counting it as running too would
          // inflate the badge by one.
          const pending = visiblePendingKind(pendingInteractions.get(id)?.kind);
          if (pending) input++;
          else if (s.running === true) running++;
          if (s.completed === true) unread++;
        }
        return { count: running + input, running, input, unread };
      }, [list, pendingInteractions, archivedSessionIds]);
      const badgeClass = "rss-badge" + (badge.input > 0 ? " rss-badgeWarn" : badge.unread > 0 ? " rss-badgeUnread" : "");
      const badgeTitle = [
        badge.running > 0 ? badge.running + " working" : "",
        badge.input > 0 ? badge.input + " need" + (badge.input === 1 ? "s" : "") + " input" : "",
        badge.unread > 0 ? badge.unread + " unread chat" + (badge.unread === 1 ? "" : "s") : ""
      ].filter(Boolean).join(", ");

      return React.createElement("div", { className: "rss-root" + (forceUnread ? " rss-forceUnread" : ""), ref: rootRef },
        React.createElement("button", {
          type: "button",
          className: "rss-trigger",
          onClick: () => setOpen((v) => !v),
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          title: currentStatus.label,
        },
          React.createElement(StatusIndicator, { status: currentStatus }),
          currentCwd ? React.createElement("span", { className: "rss-cwd" }, currentCwd) : null,
          currentCwd ? React.createElement("span", { className: "rss-cwdSep" }, "/") : null,
          React.createElement("span", { className: "rss-triggerLabel" }, currentTitle || "Switch"),
          React.createElement("span", { className: "rss-chevron" }, open ? "\u25B2" : "\u25BC"),
          React.createElement("span", { className: badgeClass, title: badgeTitle }, badge.count > 10 ? "9+" : badge.count)
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
                    onClick: () => { sessions.open(item.id); setOpen(false); },
                    title: st.label,
                  },
                    React.createElement(StatusIndicator, { status: st }),
                    item.cwd ? React.createElement("span", { className: "rss-itemCwd" }, workspaceTitleOf(item.cwd)) : null,
                    item.cwd ? React.createElement("span", { className: "rss-itemCwdSep" }, "/") : null,
                    React.createElement("span", { className: "rss-itemLabel" }, item.title)
                  ),
                  React.createElement("div", { className: "rss-itemTrailing" },
                    item.id === sessionId ? React.createElement("span", { className: "rss-currentCheck" }, React.createElement(IconCheckOutline16, { size: 16 })) : null,
                    React.createElement("button", {
                      type: "button",
                      className: "rss-itemArchive",
                      "aria-label": "Archive " + item.title,
                      title: "Archive session",
                      onClick: (e) => {
                        setOpen(false);
                        workspaces.archiveSession(item.id).then(() => {
                          // Archiving the current session leaves the switcher
                          // without a current session (dsh clears the selection);
                          // switch automatically to the freshest remaining one.
                          if (item.id === sessionId) {
                            const freshest = freshestSessionId(list, archivedSessionIds, item.id);
                            if (freshest !== undefined) sessions.open(freshest);
                          }
                        }).catch((reason) => {
                          console.warn("session archive rejected:", reason);
                        });
                      },
                    },
                      React.createElement(IconArchiveOutline20, { size: 16 })
                    )
                  )
                );
              })
        )
      );
    }
  slots.inject("conversation.session.header.utilities", () => slots.register(
    { name: "conversation.session.header.utilities", id: "recent-sessions-switcher", order: -20 },
    renderSwitcher
  ));
}