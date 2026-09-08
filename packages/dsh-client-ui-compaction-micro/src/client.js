// Compaction-micro UI marker — client half (source mirror of lib/client.js).
//
// Renders a transcript marker at every dsh-compaction-micro compaction point:
// "Context compacted — N history items (~M tokens)". The fact is read from the
// plugin's `compaction/summary` events (shadowedSeqs / shadowedTokenCount),
// which are emitted right before each replacement commit.
//
// Why a separate definition instead of reusing the built-in compaction marker:
// the built-in `compactionDefinition` (dsh-client-ui-chat) is hardwired to the
// standard provider's contract — it requires the checkpoint's `source.plugin`
// to be "compact" and the `compaction/summary` event to carry a `compactionId`.
// dsh-compaction-micro writes `source.plugin === "dsh-compaction-micro"` and no
// `compactionId`, so its replacements (replacement-surface events, model-only)
// are claimed by no chat definition and currently render nothing in the
// transcript. This plugin claims exactly the micro-style summary events —
// `compaction/summary` WITHOUT a `compactionId` (the standard provider always
// emits one, so there is no overlap) — and renders its own marker via the
// `conversation.chat.node` keyed slot. No change to dsh-compaction-micro is
// required: visualization lives entirely here.
//
// The shipped lib/client.js is this same code wrapped in the client-modules
// bundle format (window.__ModuleLoader__.load({ id, factory })) with `react`
// required from the platform seed. Keep the two in sync; lib/client.js is what
// the browser actually loads.

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

/**
 * Match one micro-compaction summary event. Only `compaction/summary` events
 * that carry no `compactionId` are claimed — the standard provider always
 * correlates its summaries by compactionId, so those belong to the built-in
 * marker and are never claimed here. Each event gets its own context keyed by
 * its seq, so every compaction produces its own transcript marker.
 * @param event - a session event.
 * @returns a match record, or null when the event is not a micro summary.
 */
const microSummaryMatch = (event) => {
  if (event.type !== "compaction/summary") return null;
  const data = event.data;
  if (data === null || typeof data !== "object") return null;
  if (typeof data.compactionId === "string") return null;
  return { id: "micro-" + event.seq, role: "update" };
};

/**
 * Build the chat-view node for one micro compaction marker.
 * @param context - the assembled business Context (its only match is the summary).
 * @returns a chat-target node, or null when there is no summary to render.
 */
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

/**
 * Renderer for the `conversation.chat.node` keyed slot. Reads the marker facts
 * off the routed node and shows a compact one-line row.
 * @param props - `{ node, t }` where `node` is the chat view node (data carries
 *   the summary projection) and `t` is the NS-bound translator.
 */
const MarkerView = ({ node, t }) => {
  const data = node.data;
  const summary = data.shadowedItemCount !== null && data.shadowedTokenCount !== null
    ? t("compaction.completed", { items: data.shadowedItemCount, tokens: data.shadowedTokenCount })
    : t("compaction.unavailable");
  const range = data.seqRange !== null ? t("compaction.range", { start: data.seqRange.start, end: data.seqRange.end }) : null;
  return React.createElement("div", { className: "cmc-row" },
    React.createElement("span", { className: "cmc-title" }, t("compaction.title")),
    React.createElement("span", { className: "cmc-sep", "aria-hidden": true }),
    React.createElement("span", { className: "cmc-summary" }, summary),
    range === null ? null : React.createElement("span", { className: "cmc-range" }, range)
  );
};

export const inject = ["slots", "uiConversation", "locale"];

export function apply(ctx) {
  const { slots, uiConversation, locale } = ctx;
  ctx.effect(() => locale.register(NS, { en, ru }), "compaction-micro: dictionaries");
  uiConversation.events.register(microCompactionDefinition);
  slots.inject("conversation.chat.node", () => slots.register(
    { name: "conversation.chat.node", key: "micro-compaction", locale: NS },
    MarkerView
  ));
}
