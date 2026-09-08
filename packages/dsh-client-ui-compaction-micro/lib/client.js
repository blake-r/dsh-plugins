window.__ModuleLoader__.load({
	id: "@blake-r/dsh-client-ui-compaction-micro",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// CSS for the marker, injected once at materialization. Uses the same
		// data-plugin-css guard the official client bundles use so re-materialization
		// (HMR / reload) does not duplicate the <style> tag.
		const css = [
			".cmc-row{display:flex;align-items:center;min-width:0;contain:size layout;height:calc(24px + var(--dsh-content-font-delta,0px))}",
			".cmc-title{flex:none;color:var(--dsw-alias-label-secondary);font-weight:400;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap}",
			".cmc-sep{flex:none;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption);margin:0 8px}",
			".cmc-summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		].join("");
		const tagId = "@blake-r/dsh-client-ui-compaction-micro/cmc.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@blake-r/dsh-client-ui-compaction-micro";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const NS = "compaction-micro";

		const en = {
			"compaction.title": "Micro-compaction",
			"compaction.completed": "{items} history items (~{tokens} tokens)",
			"compaction.unavailable": "Compaction summary unavailable"
		};

		const ru = {
			"compaction.title": "Микро-сжатие",
			"compaction.completed": "сжато {items} элементов (~{tokens} токенов)",
			"compaction.unavailable": "Сводка сжатия недоступна"
		};

		// ── consecutive-run merge state ─────────────────────────────────────────
		// The match function is shared across sessions (one ConversationEventRegistry)
		// and session events carry no session id, so the run state lives at module
		// level. The seq-monotonicity guard resets it on session switch or window
		// rebuild: seqs strictly increase within one session's stream, so a
		// non-increasing event means a different session and must not continue the
		// previous run. (Chunk events without a surface seq are ignored by the guard.)
		let lastEventSeq = -1;
		let lastMicroKind = "other"; // "summary" | "replacement" | "other"
		let currentRunId = null;

		// Match one micro-compaction summary event and group consecutive ones into a
		// single run. Only `compaction/summary` events that carry no `compactionId`
		// are claimed — the standard provider always correlates its summaries by
		// compactionId, so those belong to the built-in marker and are never claimed
		// here. A summary continues the current run (role "update", same id) when the
		// previous micro-relevant event was another summary or the plugin's own
		// replacement message; anything else (real content, injected frames, a
		// different session) starts a new run (role "start", id "micro-<seq>").
		const microSummaryMatch = (event) => {
			if (Number.isSafeInteger(event.seq)) {
				if (event.seq <= lastEventSeq) {
					lastMicroKind = "other";
					currentRunId = null;
				}
				lastEventSeq = event.seq;
			}
			if (event.type === "user/message") {
				// For user/message events the event data IS the message (dsh-session
				// projectMessage: `case "user/message": return event.data`), so the
				// plugin source sits at data.source, not data.message.source.
				const source = event.data && event.data.source;
				lastMicroKind = source !== null && source !== undefined && source.kind === "plugin" && source.plugin === "dsh-compaction-micro"
					? "replacement"
					: "other";
				return null;
			}
			if (event.type !== "compaction/summary") {
				lastMicroKind = "other";
				return null;
			}
			const data = event.data;
			if (data === null || typeof data !== "object") {
				lastMicroKind = "other";
				return null;
			}
			if (typeof data.compactionId === "string") {
				lastMicroKind = "other";
				return null;
			}
			if ((lastMicroKind === "summary" || lastMicroKind === "replacement") && currentRunId !== null) {
				lastMicroKind = "summary";
				return { id: currentRunId, role: "update" };
			}
			currentRunId = "micro-" + event.seq;
			lastMicroKind = "summary";
			return { id: currentRunId, role: "start" };
		};

		// Build the chat-view node for one micro compaction marker (one run of
		// consecutive summaries). Items and tokens are summed across every summary in
		// the run; the seq range is deliberately not shown.
		const microCompactionNode = (context) => {
			const summaries = context.matches.filter((match) => match.event.type === "compaction/summary");
			if (summaries.length === 0) return null;
			let shadowedItemCount = 0;
			let shadowedTokenCount = 0;
			let valid = true;
			for (const match of summaries) {
				const data = match.event.data;
				if (Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)) {
					shadowedItemCount += data.shadowedSeqs.length;
				} else {
					valid = false;
				}
				if (Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0) {
					shadowedTokenCount += data.shadowedTokenCount;
				} else {
					valid = false;
				}
			}
			if (!valid) {
				shadowedItemCount = null;
				shadowedTokenCount = null;
			}
			const first = summaries[0];
			return {
				key: context.key,
				kind: "micro-compaction",
				id: context.id,
				target: "chat",
				anchorSeq: first.event.seq,
				location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
				visibility: "visible",
				data: {
					seq: first.event.seq,
					time: first.event.time,
					shadowedItemCount,
					shadowedTokenCount
				}
			};
		};

		const microCompactionDefinition = {
			kind: "micro-compaction",
			target: "chat",
			match: microSummaryMatch,
			start: () => ({}),
			update: (state, match) => ({ summary: match }),
			buildViewNode: microCompactionNode
		};

		// Renderer for the `conversation.chat.node` keyed slot. Reads the marker facts
		// off the routed node and shows a compact one-line row.
		const MarkerView = ({ node, t }) => {
			const data = node.data;
			const summary = data.shadowedItemCount !== null && data.shadowedTokenCount !== null
				? t("compaction.completed", { items: data.shadowedItemCount, tokens: data.shadowedTokenCount })
				: t("compaction.unavailable");
			return react.createElement("div", { className: "cmc-row" },
				react.createElement("span", { className: "cmc-title" }, t("compaction.title")),
				react.createElement("span", { className: "cmc-sep", "aria-hidden": true }),
				react.createElement("span", { className: "cmc-summary" }, summary)
			);
		};

		const inject = ["slots", "uiConversation", "locale"];

		function apply(ctx) {
			const { slots, uiConversation, locale } = ctx;
			ctx.effect(() => locale.register(NS, { en, ru }), "compaction-micro: dictionaries");
			uiConversation.events.register(microCompactionDefinition);
			slots.inject("conversation.chat.node", () => slots.register(
				{ name: "conversation.chat.node", key: "micro-compaction", locale: NS },
				MarkerView
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});