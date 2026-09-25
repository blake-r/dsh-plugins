window.__ModuleLoader__.load({
	id: "@blake-r/dsh-client-ui-recent-sessions-switcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// CSS for the switcher, injected once at materialization. Uses the same
		// data-plugin-css guard the official client bundles use so re-materialization
		// (HMR / reload) does not duplicate the <style> tag.
		const css = [
			".rss-root{position:relative;display:inline-flex;align-items:center}",
			".rss-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:260px;padding:0 10px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:8px;cursor:pointer;font-size:13px;line-height:20px}",
			".rss-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".rss-trigger:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
			".rss-dot{flex:none;width:8px;height:8px;border-radius:50%}",
			".rss-dotIdle{flex:none;width:8px;height:8px;border-radius:50%;background:transparent;border:1px solid var(--dsw-alias-border-l2,#c0c4cc)}",
			".rss-forceUnread .rss-dotIdle{background:var(--dsw-alias-state-success-primary);border-color:transparent}",
			".rss-dotSlot{flex:none;width:10px;height:10px;display:inline-flex;align-items:center;justify-content:center}",
			".rss-matrix{flex:none;width:10px;height:10px;color:var(--dsh-state-ongoing,#5686fe)}",
			".rss-matrix rect{fill:currentColor;opacity:.15;animation:rss-chase 1s infinite}",
			".rss-matrix rect:nth-child(1){animation-delay:-1000ms}",
			".rss-matrix rect:nth-child(2){animation-delay:-875ms}",
			".rss-matrix rect:nth-child(3){animation-delay:-750ms}",
			".rss-matrix rect:nth-child(4){animation-delay:-625ms}",
			".rss-matrix rect:nth-child(5){animation-delay:-500ms}",
			".rss-matrix rect:nth-child(6){animation-delay:-375ms}",
			".rss-matrix rect:nth-child(7){animation-delay:-250ms}",
			".rss-matrix rect:nth-child(8){animation-delay:-125ms}",
			"@keyframes rss-chase{0%,12.4%{opacity:1}12.5%,24.9%{opacity:.6}25%,37.4%{opacity:.35}37.5%,to{opacity:.15}}",
			".rss-cwd{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}",
			".rss-cwdSep{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".rss-triggerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".rss-chevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px}",
			".rss-badge{flex:none;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:transparent;border:1px solid var(--dsw-alias-border-l2,#c0c4cc);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px;font-weight:600;text-align:center}",
			".rss-badgeUnread{background:var(--dsw-alias-state-success-primary);border-color:transparent;color:#fff}",
			".rss-badgeWarn{background:var(--dsw-alias-state-warn-primary);border-color:transparent;color:#fff}",
			".rss-badgeError{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}",
			".rss-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:30;min-width:220px;max-width:320px;max-height:320px;overflow-y:auto;padding:4px;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18)}",
			".rss-item{display:flex;align-items:center;width:100%;border-radius:6px}",
			".rss-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".rss-itemMain{display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-align:left;padding:6px 10px;border:none;background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;cursor:pointer;font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".rss-itemTrailing{position:relative;flex:none;width:20px;height:20px;margin-right:6px}",
			".rss-itemArchive{position:absolute;inset:0;display:inline-flex;align-items:center;justify-content:flex-end;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;cursor:pointer;opacity:0;transition:opacity .1s}",
			".rss-item:hover .rss-itemArchive,.rss-itemArchive:focus-visible{opacity:1}",
			".rss-itemArchive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".rss-itemCwd{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}",
			".rss-itemCwdSep{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".rss-itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}",
			".rss-current .rss-itemMain{color:var(--dsw-alias-state-business-primary);font-weight:500}",
			".rss-currentCheck{position:absolute;inset:0;display:inline-flex;align-items:center;justify-content:flex-end;color:var(--dsw-alias-state-business-primary);transition:opacity .1s}",
			".rss-item:hover .rss-currentCheck{opacity:0}",
			".rss-empty{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:13px}",
			// Hero ("new session") dock: `conversation.input.dock` renders above the
			// prompt card inside dsh's composer stack. dsh marks the conversation root
			// with a stable `data-phase` attribute ("settling" | "hero" | "active"), so
			// the dock copy shows only while the phase is `hero` — the header copy owns
			// the `active` phase.
			".rss-heroDock{display:none}",
			// The dock row sits in the hero composer stack directly below dsh's hero
			// chip row (`wSkVaW_heroWorkspaceRow`: 28px pill chips, 16px inner right
			// padding). Instead of claiming a line of its own - which left the trigger
			// floating on its own between the chips and the prompt card - the row
			// collapses to zero height and the trigger is lifted onto the chip row's
			// baseline, right-aligned with the chips, styled as a peer pill. The lift
			// cancels the 8px gap dsh puts between the two rows.
			"[data-phase=\"hero\"] .rss-heroDock{position:relative;display:block;height:0;overflow:visible}",
			"[data-phase=\"hero\"] .rss-heroDock .rss-root{position:absolute;right:16px;bottom:var(--rss-hero-dock-lift,8px)}",
			"[data-phase=\"hero\"] .rss-heroDock .rss-trigger{height:28px;padding:0 8px;gap:4px;border-radius:16px;color:var(--dsw-alias-label-primary);font-weight:500}",
			"[data-phase=\"hero\"] .rss-heroDock .rss-chevron{color:var(--dsw-alias-label-caption)}",
			// The trigger now lives on the chip row, so its dropdown must not drop over
			// the prompt card: it opens upward into the empty hero space.
			"[data-phase=\"hero\"] .rss-heroDock .rss-menu{top:auto;bottom:calc(100% + 6px)}",
			// Narrow hero: a long workspace/preset chip pair can reach the right edge
			// of the chip row, so the label collapses to the clock glyph (dsh does the
			// same with its own composer-stack triggers on narrow containers).
			"@media (max-width:860px){[data-phase=\"hero\"] .rss-heroDock .rss-triggerLabel{display:none}}"
		].join("");
		const tagId = "@blake-r/dsh-client-ui-recent-sessions-switcher/rss.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@blake-r/dsh-client-ui-recent-sessions-switcher";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const workspaceTitleOf = (path) => {
			if (!path) return "";
			const trimmed = path.replace(/[\\/]+$/, "");
			const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return trimmed.slice(separator + 1);
		};

		// In-memory registry of sessions whose last request failed. Populated from the
		// host's `api-session/error` event (agent-loop uncontained errors, including
		// LLM request failures, and background-activation failures) and cleared when
		// the session runs again or disappears from the list. Same reload limitation
		// as `completionUnread`: a page reload forgets errors. The two registrations
		// (header + hero dock) share this single map and one subscription.
		const sessionErrors = new Map();

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

		// Status model mirrors dsh's StateDot:
		//  - pending  -> "warning" (orange, awaiting user input)
		//  - running  -> "ongoing"  (animated matrix, DeepSeek brand blue #5686fe)
		//  - completed-> "done"     (green, idle with unread output)
		//  - else     -> "idle"     (transparent dot with silver outline)
		// A session whose own loop is idle but whose subagent descendants are
		// active renders as active too: "Working (subagents)" (ongoing) while any
		// descendant runs, "Needs input (subagent)" (warning) while any descendant
		// awaits input — the same priority order the badge uses (input outranks
		// running). Green ("done") additionally requires the session's subtree to
		// be finished: a parent whose subagents are still running renders active,
		// never green.
		const statusOf = (s) => {
			if (s.pending) return { state: "warning", label: "Needs input" };
			if (s.running) return { state: "ongoing", label: "Working" };
			if (s.hasPendingDescendant) return { state: "warning", label: "Needs input (subagent)" };
			if (s.hasRunningDescendant) return { state: "ongoing", label: "Working (subagents)" };
			if (s.errored && s.finished) return { state: "error", label: "Last request failed" };
			if (s.completed && s.finished) return { state: "done", label: "Idle, unread output" };
			return { state: "idle", label: "Idle, all read" };
		};

		// Total active-agent picture across ALL sessions (visible and subagent of
		// any parent, archived included — archiving does not stop an agent) plus,
		// per session, whether a running or input-awaiting descendant exists. A
		// session is "finished" only when it is not running and none of its
		// subagent descendants (transitively) are running; green is reserved for
		// that state, so a parent whose subagents are still working never turns
		// green. One session = at most one active agent: an agent paused on a
		// question/approval keeps its loop phase "running", so it counts under
		// input only — and pending counts only for a running agent (a stopped
		// agent leaves a stale pending interaction behind). A running session
		// whose parent is missing from the registry cannot be attributed to any
		// ancestor, so no session is then treated as finished (its green would be
		// a lie). `unreadFinished` counts visible (non-subagent, non-archived)
		// sessions that are both completion-unread and finished — the exact set
		// the badge's green lights for; unrelated activity elsewhere does not
		// suppress it (the finished gate is per-session, not global). Running
		// state prefers the live `sessionStatus` value over the list row (dsh's
		// own workspace browser does the same).
		const deriveActivity = (list, statuses, archivedSessionIds) => {
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
			// Mark every ancestor of an input-awaiting (pending && running) session
			// as "has a pending descendant" — a subset of the running walk above,
			// kept separate so the parent renders "Needs input (subagent)" rather
			// than "Working (subagents)".
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
			// Finished-with-unread / failed-last-request count: visible, non-archived,
			// not running with no running descendant and no unattributed running. An
			// errored session is excluded from green (no double count) and reported as
			// `errored` instead; `firstError` carries the first error message for the
			// red pill's title. Red is a fact (includes the current session), green is
			// an unread reminder (excludes it).
			for (const id of list.ids) {
				const s = byId[id];
				if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
				const status = statuses.get(id);
				const running = status?.running ?? (s.running === true);
				if (running) continue;
				if (result.unattributedRunning || result.hasRunningDescendant.get(id)) continue;
				const errorMessage = sessionErrors.get(id);
				if (errorMessage !== undefined) {
					result.errored++;
					if (result.firstError === undefined && errorMessage.trim() !== "") result.firstError = errorMessage.length > 200 ? errorMessage.slice(0, 200) + "…" : errorMessage;
					continue;
				}
				if (status?.completionUnread === true) result.unreadFinished++;
			}
			return result;
		};

		// Pure badge view from the activity picture. Orange (input) outranks red
		// (failed last request), which outranks green (unread); the number reads the
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

		// Pure dropdown cap: active/flagged sessions first, then the most
		// recently updated others, capped at 8 — but the current session is
		// always rendered, even when it falls outside the cap (a selected parent
		// whose subagents are working must stay reachable and visible with its
		// activity icon).
		const capRecent = (items, sessionId) => {
			const priority = items.filter((i) => i.running || i.completed || i.errored || i.pending || i.hasRunningDescendant || i.hasPendingDescendant);
			const rest = items.filter((i) => !i.running && !i.completed && !i.errored && !i.pending && !i.hasRunningDescendant && !i.hasPendingDescendant);
			const restCapped = rest.slice(0, Math.max(0, 8 - priority.length));
			const currentItem = items.find((i) => i.id === sessionId);
			if (currentItem !== undefined && !priority.includes(currentItem) && !restCapped.includes(currentItem)) restCapped.push(currentItem);
			return priority.concat(restCapped);
		};

		// Renders the same animated matrix StateDot uses for "ongoing" in dsh.
		const StatusIndicator = ({ status }) => {
			if (status.state === "ongoing") {
				const cells = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]];
				return react.createElement("svg", { className: "rss-matrix", width: 10, height: 10, viewBox: "0 0 10 10", shapeRendering: "crispEdges", "aria-hidden": "true" },
					cells.map(([x, y], c) => react.createElement("rect", { key: c, x, y, width: 2, height: 2 }))
				);
			}
			if (status.state === "warning") {
				return react.createElement("span", { className: "rss-dot", style: { background: "var(--dsw-alias-state-warn-primary)" } });
			}
			if (status.state === "error") {
				return react.createElement("span", { className: "rss-dot", style: { background: "var(--dsw-alias-state-error-primary)" } });
			}
			if (status.state === "done") {
				return react.createElement("span", { className: "rss-dot", style: { background: "var(--dsw-alias-state-success-primary)" } });
			}
			// idle: transparent dot with a silver outline (keeps alignment)
			return react.createElement("span", { className: "rss-dotSlot" },
				react.createElement("span", { className: "rss-dotIdle" })
			);
		};

		const inject = ["slots", "sessions", "workspaces", "uiWorkspace", "remote"];

		function apply(ctx) {
			const slots = ctx.slots;
			const sessions = ctx.sessions;
			const workspaces = ctx.workspaces;
			const uiWorkspace = ctx.uiWorkspace;
			const remote = ctx.remote;
			// One subscription feeds both registrations: the host emits
			// `api-session/error(sessionId, message)` on agent-loop uncontained errors
			// (including LLM request failures) and on background-activation failures.
			ctx.effect(() => {
				if (remote === undefined || typeof remote.$on !== "function") return;
				return remote.$on("api-session/error", (sessionId, message) => {
					if (typeof sessionId === "string" && typeof message === "string") sessionErrors.set(sessionId, message);
				});
			});
			// One component serves two registrations: the header utilities row
			// (active Session) and the hero dock row (new Session). `heroDock` is
			// injected by the second registration so the trigger label can differ
			// while the blank Session has no title yet.
			const renderSwitcher = (props) => {
					const { useSessions, useSessionStatus, useWorkspaces, sessionId, heroDock } = props;
					const list = useSessions((s) => s);
					// dsh 0.1.7-rc.2 replaced the root `sessionPendingInteraction` hook with
					// `sessionStatus`; each entry carries the session's pending interaction,
					// live running state and the completionUnread ("finished with unread
					// output") heuristic dsh's own StateDot uses.
					const status = useSessionStatus((s) => s);
					const workspaceSnapshot = useWorkspaces((s) => s);
					const archivedSessionIds = workspaceSnapshot.archivedSessionIds;
					const [open, setOpen] = react.useState(false);
					const [forceUnread, setForceUnread] = react.useState(false);
					const rootRef = react.useRef(null);
					const currentRunningRef = react.useRef(false);

					// dsh's own `completed` heuristic intentionally stays false for the
					// currently-selected session, so a session that finished while the window
					// was unfocused would otherwise render as "idle, all read". We force the
					// green ("unread") dot with a CSS class: armed the moment the window loses
					// focus while the current session was still running, cleared on refocus.
					// The class is applied only when the current session's subtree is
					// finished, so a parent whose subagents are still working stays silver
					// even while the window is unfocused.
					react.useEffect(() => {
						const onBlur = () => { if (currentRunningRef.current) setForceUnread(true); };
						const onFocus = () => setForceUnread(false);
						window.addEventListener("blur", onBlur);
						window.addEventListener("focus", onFocus);
						return () => {
							window.removeEventListener("blur", onBlur);
							window.removeEventListener("focus", onFocus);
						};
					}, []);

					react.useEffect(() => {
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

					// Error-registry hygiene: a session that runs again is no longer failed,
					// and a session that vanished from the list cannot stay failed. Runs on
					// every status/list change (the error event itself is followed by the
					// idle status event, which re-renders and lets the red badge appear).
					react.useEffect(() => {
						for (const [id, running] of status) {
							if (running === true) sessionErrors.delete(id);
						}
						if (list.phase === "ready") {
							for (const id of sessionErrors.keys()) {
								if (!(id in list.byId)) sessionErrors.delete(id);
							}
						}
					}, [status, list]);

					// Workspace display name for a session: the Workspace's user-chosen
					// `title` when the session is accounted to one (the title may differ from
					// the directory basename), otherwise the cwd basename. Mirrors dsh's own
					// resolution (workspace browser search rows, hero workspace chip).
					const workspaceBySession = react.useMemo(() => {
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
					// the dropdown rows and the forced-unread class. Running state prefers
					// the live `sessionStatus` value over the list row (dsh's own workspace
					// browser does the same).
					const activity = react.useMemo(
						() => deriveActivity(list, status, archivedSessionIds),
						[list, status, archivedSessionIds]
					);
					const runningOf = (s) => s !== undefined && (status.get(s.id)?.running ?? (s.running === true));
					const finished = (s) => s !== undefined && !runningOf(s) && !activity.unattributedRunning && !activity.hasRunningDescendant.get(s.id);

					const recent = react.useMemo(() => {
						if (list.phase !== "ready") return [];
						const archived = new Set(archivedSessionIds);
						const items = [];
						for (const id of list.ids) {
							const s = list.byId[id];
							if (s === undefined || s.blank || s.origin === "subagent" || archived.has(id)) continue;
							items.push({ id, title: s.displayTitle, workspace: workspaceLabelOf(s), cwd: s.cwd, updatedAt: s.updatedAt, running: runningOf(s), completed: status.get(id)?.completionUnread === true, errored: sessionErrors.has(id), pending: runningOf(s) ? visiblePendingKind(status.get(id)?.pendingInteraction?.kind) : undefined, finished: finished(s), hasRunningDescendant: activity.hasRunningDescendant.get(id) === true, hasPendingDescendant: activity.hasPendingDescendant.get(id) === true });
						}
						items.sort((a, b) => b.updatedAt - a.updatedAt);
						// Always include every active (running), unread (completed),
						// input-requiring (pending), or descendant-active session; fill
						// the remaining slots up to 8 with the most recently-updated
						// others. The current session is always rendered even beyond the
						// cap (see capRecent). Within each group the sort above (by
						// last-modified time) is preserved.
						return capRecent(items, sessionId);
					}, [list, status, archivedSessionIds, workspaceBySession, activity, sessionId]);

					const current = list.byId[sessionId];
					currentRunningRef.current = current ? current.running === true : false;
					const currentFinished = finished(current);
					const currentTitle = current && !current.blank ? current.displayTitle : "";
					const currentWorkspace = current && current.cwd ? workspaceLabelOf(current) : "";
					const currentStatus = current
						? statusOf({ running: runningOf(current), completed: status.get(sessionId)?.completionUnread === true, errored: sessionErrors.has(sessionId), pending: runningOf(current) ? visiblePendingKind(status.get(sessionId)?.pendingInteraction?.kind) : undefined, finished: currentFinished, hasRunningDescendant: activity.hasRunningDescendant.get(sessionId) === true, hasPendingDescendant: activity.hasPendingDescendant.get(sessionId) === true })
						: { state: "idle", label: "Idle" };
					// Badge: total active agents (working or awaiting input) across
					// ALL sessions, including the current one and every running
					// subagent. Orange when any agent awaits input (outranks green);
					// green when some visible session is finished (its whole subtree
					// done) with unread output — unrelated activity elsewhere no
					// longer blocks it, and a finished parent whose own subagents are
					// still working never turns the badge green. The number reads the
					// finished-unread count while green, else the total active count
					// (see badgeView).
					const badge = badgeView(activity);
					// On the hero dock the bound Session is blank, so there is no title
					// to pair the workspace with: drop the `cwd /` prefix rather than
					// render "dsh / Recent sessions" (the hero workspace chip already
					// names the workspace).
					const isHeroDock = heroDock === true;
					const showCwd = currentWorkspace !== "" && !(isHeroDock && currentTitle === "");
					// Hero screen with nothing to switch to (and nothing running): show no
					// control at all rather than an inert trigger that reads "0".
					if (isHeroDock && recent.length === 0) return null;

					return react.createElement("div", { className: "rss-root" + (forceUnread && currentFinished ? " rss-forceUnread" : ""), ref: rootRef },
						react.createElement("button", {
							type: "button",
							className: "rss-trigger",
							onClick: () => setOpen((v) => !v),
							"aria-haspopup": "listbox",
							"aria-expanded": open,
							title: isHeroDock ? "Recent sessions" : currentStatus.label,
						},
							// The status dot reports the bound Session's state; on the hero
							// screen no Session is bound, so a plain clock icon stands in and
							// the trigger reads as one of the hero chips.
							isHeroDock
								? react.createElement(primitives.IconClockOutlineMedium, { size: 14 })
								: react.createElement(StatusIndicator, { status: currentStatus }),
							showCwd ? react.createElement("span", { className: "rss-cwd" }, currentWorkspace) : null,
							showCwd ? react.createElement("span", { className: "rss-cwdSep" }, "/") : null,
							react.createElement("span", { className: "rss-triggerLabel", title: isHeroDock ? "Recent sessions" : undefined }, currentTitle || (isHeroDock ? "Recent" : "Switch")),
							react.createElement("span", { className: "rss-chevron" }, open ? "\u25B2" : "\u25BC"),
							react.createElement("span", { className: badge.cls, title: badge.title }, badge.number)
						),
						open && react.createElement("div", { className: "rss-menu", role: "listbox" },
							recent.length === 0
								? react.createElement("div", { className: "rss-empty" }, "No sessions")
								: recent.map((item) => {
									const st = statusOf(item);
									return react.createElement("div", {
										key: item.id,
										role: "option",
										className: "rss-item" + (item.id === sessionId ? " rss-current" : ""),
									},
										react.createElement("button", {
											type: "button",
											className: "rss-itemMain",
											onClick: () => { uiWorkspace.openSession(item.id); setOpen(false); },
											title: st.label,
										},
											react.createElement(StatusIndicator, { status: st }),
											item.workspace ? react.createElement("span", { className: "rss-itemCwd" }, item.workspace) : null,
											item.workspace ? react.createElement("span", { className: "rss-itemCwdSep" }, "/") : null,
											react.createElement("span", { className: "rss-itemLabel" }, item.title)
										),
										react.createElement("div", { className: "rss-itemTrailing" },
											item.id === sessionId ? react.createElement("span", { className: "rss-currentCheck" }, react.createElement(primitives.IconCheckOutlineMedium, { size: 16 })) : null,
											react.createElement("button", {
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
												react.createElement(primitives.IconArchiveOutlineMedium, { size: 16 })
											)
										)
									);
								})
						)
					);
			};
			// The new-Session ("hero") screen renders the header - and with it every
			// `conversation.session.header.*` slot - empty: dsh hides the header chrome
			// while the bound Session is blank and renders no header at all when none is
			// selected. `conversation.input.dock` is the list slot the hero composer
			// stack renders directly above the prompt card, so the same switcher mounts
			// there for the new-Session screen. Visibility is decided by CSS off dsh's
			// stable `data-phase` root attribute, so the dock copy only shows while the
			// phase is `hero` and does not duplicate the header one afterwards.
			const renderHeroDock = (props) => react.createElement(
				"div",
				{ className: "rss-heroDock" },
				react.createElement(renderSwitcher, props)
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

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});