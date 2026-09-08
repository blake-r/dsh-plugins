// Compaction-micro UI marker — client half (source mirror of lib/client.js).
//
// Renders a transcript marker at every dsh-compaction-micro compaction point:
// "Micro-compaction — N history items (~M tokens)". The fact is read from the
// plugin's `compaction/summary` events (shadowedSeqs / shadowedTokenCount),
// which are emitted right before each replacement commit.
//
// Consecutive micro compactions are collapsed into ONE marker: a run continues
// while the stream between summaries carries only the plugin's own replacement
// messages (user/message with source.plugin === "dsh-compaction-micro") — the
// transcript-adjacent case (several spans folded in one turn/end). Any real
// content (user/assistant/tool events, injected frames) breaks the run and
// starts a new marker. The merged marker sums items and tokens across the run;
// the seq range is deliberately not shown.
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
  "compaction.title": "Micro-compaction",
  "compaction.completed": "{items} history items (~{tokens} tokens)",
  "compaction.unavailable": "Compaction summary unavailable"
};

const ru = {
  "compaction.title": "Микро-сжатие",
  "compaction.completed": "сжато {items} элементов (~{tokens} токенов)",
  "compaction.unavailable": "Сводка сжатия недоступна"
};

// ── consecutive-run merge state ─────────────────────────────────────────────
// The match function is shared across sessions (one ConversationEventRegistry)
// and session events carry no session id, so the run state lives at module
// level. The seq-monotonicity guard resets it on session switch or window
// rebuild: seqs strictly increase within one session's stream, so a
// non-increasing event means a different session and must not continue the
// previous run. (Chunk events without a surface seq are ignored by the guard.)
let lastEventSeq = -1;
let lastMicroKind = "other"; // "summary" | "replacement" | "other"
let currentRunId = null;

/**
 * Match one micro-compaction summary event and group consecutive ones into a
 * single run. Only `compaction/summary` events that carry no `compactionId`
 * are claimed — the standard provider always correlates its summaries by
 * compactionId, so those belong to the built-in marker and are never claimed
 * here. A summary continues the current run (role "update", same id) when the
 * previous micro-relevant event was another summary or the plugin's own
 * replacement message; anything else (real content, injected frames, a
 * different session) starts a new run (role "start", id "micro-<seq>").
 * @param event - a session event.
 * @returns a match record, or null when the event is not a micro summary.
 */
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

/**
 * Build the chat-view node for one micro compaction marker (one run of
 * consecutive summaries). Items and tokens are summed across every summary in
 * the run; the seq range is deliberately not shown.
 * @param context - the assembled business Context (its matches are the run's summaries).
 * @returns a chat-target node, or null when there is no summary to render.
 */
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
  return React.createElement("div", { className: "cmc-row" },
    React.createElement("span", { className: "cmc-title" }, t("compaction.title")),
    React.createElement("span", { className: "cmc-sep", "aria-hidden": true }),
    React.createElement("span", { className: "cmc-summary" }, summary)
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