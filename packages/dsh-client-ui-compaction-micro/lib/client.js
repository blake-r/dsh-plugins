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
			".cmc-row{display:flex;align-items:center;gap:8px;min-width:0;padding:2px 0}",
			".cmc-title{flex:none;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:nowrap}",
			".cmc-sep{flex:none;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption);margin:0 4px}",
			".cmc-summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".cmc-range{flex:none;color:var(--dsw-alias-label-caption);font:400 11px/16px var(--ds-font-family-code)}"
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
			"compaction.title": "Context compacted",
			"compaction.completed": "{items} history items (~{tokens} tokens)",
			"compaction.range": "seqs {start}\u2013{end}",
			"compaction.unavailable": "Compaction summary unavailable"
		};

		const ru = {
			"compaction.title": "Контекст сжат",
			"compaction.completed": "сжато {items} элементов (~{tokens} токенов)",
			"compaction.range": "seqs {start}\u2013{end}",
			"compaction.unavailable": "Сводка сжатия недоступна"
		};

		// Match one micro-compaction summary event. Only `compaction/summary`
		// events that carry no `compactionId` are claimed — the standard provider
		// always correlates its summaries by compactionId, so those belong to the
		// built-in marker and are never claimed here. Each event gets its own
		// context keyed by its seq, so every compaction produces its own marker.
		const microSummaryMatch = (event) => {
			if (event.type !== "compaction/summary") return null;
			const data = event.data;
			if (data === null || typeof data !== "object") return null;
			if (typeof data.compactionId === "string") return null;
			return { id: "micro-" + event.seq, role: "update" };
		};

		// Build the chat-view node for one micro compaction marker.
		const microCompactionNode = (context) => {
			const summary = context.matches.find((match) => match.event.type === "compaction/summary");
			if (summary === undefined) return null;
			const data = summary.event.data;
			const shadowedItemCount = Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)
				? data.shadowedSeqs.length
				: null;
			const shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0
				? data.shadowedTokenCount
				: null;
			const range = data.shadowedRange;
			const seqRange = range !== null && typeof range === "object" && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
				? { start: range.start, end: range.end }
				: null;
			return {
				key: context.key,
				kind: "micro-compaction",
				id: context.id,
				target: "chat",
				anchorSeq: summary.event.seq,
				location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
				visibility: "visible",
				data: {
					seq: summary.event.seq,
					time: summary.event.time,
					shadowedItemCount,
					shadowedTokenCount,
					seqRange
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

		// Renderer for the `conversation.chat.node` keyed slot. Reads the marker
		// facts off the routed node and shows a compact one-line row.
		const MarkerView = ({ node, t }) => {
			const data = node.data;
			const summary = data.shadowedItemCount !== null && data.shadowedTokenCount !== null
				? t("compaction.completed", { items: data.shadowedItemCount, tokens: data.shadowedTokenCount })
				: t("compaction.unavailable");
			const range = data.seqRange !== null ? t("compaction.range", { start: data.seqRange.start, end: data.seqRange.end }) : null;
			return react.createElement("div", { className: "cmc-row" },
				react.createElement("span", { className: "cmc-title" }, t("compaction.title")),
				react.createElement("span", { className: "cmc-sep", "aria-hidden": true }),
				react.createElement("span", { className: "cmc-summary" }, summary),
				range === null ? null : react.createElement("span", { className: "cmc-range" }, range)
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
