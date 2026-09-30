// micro-compaction.js
// Cordis plugin: per-request trajectory re-composition.
//
// After every completed agent request (anchored on the `turn/end` event), every
// assistant-turn session since our last content re-installation is re-composed
// into a compact, recall-linked view. Each session (a contiguous run of
// assistant/message and tool/result nodes) is folded by its own replace, so
// user messages and injected frames between sessions stay live:
//   - tool calls      -> `* name "description" (seq N -> result M)`  (name plus
//                        the model-authored `description` from the arguments,
//                        when present; no raw argument blobs). `-> result M` is
//                        the pointer to the result row this fold shadows. A call
//                        whose result carried the structured `isError` flag gets
//                        a `, fail` marker so the model still sees the call was
//                        attempted and did not succeed.
//   - tool results    -> every folded result row keeps a pointer line of its
//                        own, `* tool-result (seq N)`; the body is never
//                        inlined (removing it is what the fold is for — recall
//                        recovers it), and the call row above carries
//                        `-> result M` when the pair lies in the same fold. A
//                        result whose call row is outside the range (its call
//                        was folded in an earlier pass) is still pointed at.
//   - reasoning       -> dropped
//   - assistant text  -> kept verbatim, back-linked with `(seq N)`
//   - user attachments -> media/documents/other blocks in every REAL user message
//                        the agent has already passed (source.kind === "user",
//                        with a subsequent assistant/tool node after it) are folded
//                        into `[image] (seq N)` / `[document] (seq N)` /
//                        `[<type>] (seq N)` links, text kept verbatim. Injected
//                        frames and the last (not-yet-answered) user message stay
//                        live.
// The boundary is OUR nearest replacement (`user/message` with
// `source.kind === "plugin:dsh-compaction-micro"`); everything at or before it is
// already folded and never re-wrapped. User messages, injected frames
// (workspace instructions, skill catalog, system-prompt snapshots, prior
// checkpoints) and earlier compaction replacements are left as live surface
// nodes, so the injecting plugins keep seeing their original messages and never
// re-inject. The replacement is emitted as a plugin-authored user message whose
// content is the folded assistant run.
//
// No truncation, no token budgets, no checkpoint framing: the result is a
// plain re-composed context — nothing but elision plus recall links. The
// durable append-only event log is never mutated, so everything cut is
// recoverable through the `recall` / `search` tools.
//
// A turn that ended abnormally — `error`, `max-tokens` ("Output token limit
// reached"), `aborted`, or `blocked` — or a completed turn whose last assistant
// message is reasoning-only folds everything up to the previous turn, keeping
// only the last (problematic) session live so the interrupted reply / chain of
// thought survives for a "Continue" prompt. This `keepLastSession` behavior is
// gated behind the `compactOnAbnormal` config flag (default `false`):
// when disabled, compaction is skipped entirely on such turn ends so past
// sessions are never compressed on a request failure.
//
// ── mid-turn firing (agents/pre-step) ─────────────────────────────────────────
// A long agent turn never fires `turn/end`, so `dsh-compaction-basic` (a lossy
// LLM summarization) could fire first at `agent/pre-step` and destroy the
// model's working reasoning. This plugin now ALSO listens at `agent/pre-step`
// (the same event basic uses) and, when the surface crosses a configurable
// pressure threshold, structurally folds the OLDEST foldable content of the
// current turn into a one-liner checkpoint — always BEFORE basic runs, because
// the host-plane listener registers ahead of the preset-plane basic listener
// (`{ prepend: true }` as belt-and-suspenders) and the fold commits
// synchronously inside the handler, so basic's own pressure measurement on the
// same step observes the post-fold surface.
//
// The fold at pre-step is deliberately SYNCHRONOUS (no `queueMicrotask`
// deferral like the `turn/end` path): at pre-step no `session.append` is
// mid-publish, so direct appends are legal, and deferring to a microtask would
// let basic's handler measure the PRE-fold surface and double-compact. The
// `turn/end` path keeps its microtask deferral because `session/event` fires
// INSIDE `session.append(...)` where reentrant appends are banned.
//
// Trigger (both conditions, Q26):
//   microThreshold = floor(min(W*thresholdRatio, W − maxTokens − headroomTokens)) − chunkTokens
//   W/maxTokens come from the harness (llm.resolveModelInfo + the durable
//   request header), with the SAME thresholdRatio/headroomTokens knob names and
//   defaults as dsh-compaction-basic, so both compactors configure alike and
//   micro always fires exactly one `chunkTokens` budget earlier.
//   skip-guard: `foldableChunks >= 1` (derived from lockedChunks; the foldable
//   content must be older than the locked window). The locked window (the last
//   `lockedChunks` chunk-objects, `1 < locked <= 2` chunks by default) is never
//   folded, so the model's live tail stays intact mid-turn.
//
// Chunk window: foldable content of the current turn (assistant/message and
// tool/result nodes after the nearest checkpoint) is priced with the vendored
// heuristic and sliced into `chunkTokens` chunks from the oldest node. The last
// `lockedChunks` chunk-objects form the locked window; everything older is
// foldable. The fold boundary is aligned to complete call → result pairs (a
// dangling call at the boundary is backed off one node and waits for its result).
//
// Checkpoint lifecycle (3.8): every replacement is a `micro-checkpoint` — its
// message carries `source.micro` metadata (phase, turn, seq span, tokens,
// folded counts). At the next normal `turn/end` the whole turn's checkpoint
// block plus its remaining live content is consolidated into ONE per-turn
// node, and that node's content follows the SAME fold semantics as every other
// fold (Q29): reasoning dropped, tool call/result folded to pointers,
// everything else kept verbatim — mid-turn checkpoints inside the span are
// already-compiled content and carry over verbatim in surface order. This caps
// checkpoint NODE overhead at O(turns) while keeping the concentrated content
// (user decision): a 15-fold turn ends as one node, not ~30K of one-liners
// (e2c13124 lesson: 47-58 folds → 101K tokens). The context grows gradually
// per turn; basic compaction remains the long-range backstop.
//
// Frame policy (3.9): old copies of injected frames (skill-catalog,
// agent-instructions, goal, runtime-context) are DELETED from the surface,
// keeping only the LATEST version per frame type; real user messages and
// non-dedupe live messages (agent-message relays, tool-jobs, session-reference,
// subagent-settled) always stay. The durable log is unchanged — recall works.
//
// Tool-pairing (3.10): a fold may only be committed where the engine's own
// balance contract holds — the cut before its first shadowed node and the cut
// after its last one must both be cuts the engine accepts (no tool call left
// unanswered across them). The predicates are `toolPairingBalancedBefore` /
// `toolPairingBalancedAfter` of `@deepseek-ai/dsh-compaction`, resolved at
// runtime through the composition loader (no dependency is added). The
// token-driven mid-turn end is snapped onto the nearest such cut, and every
// fold path (mid-turn, turn/end consolidation, per-session, frame policy,
// attachment) is floor-checked in `commitReplacement`/its own branch. Without
// the oracle nothing is folded: an unchecked boundary is the corruption this
// guard exists to prevent (a `tool/result` whose call the same fold removed
// leaves the surface uncuttable — see 3.5, which only guarded a trailing call
// row). Skipping a fold is recoverable; an orphan result is not.
//
// Result detection (3.11): the digest and the dangling-call guard read a tool
// result from its v4 shape — `deriveEventMessage` gives `tool/result` events a
// `role: "tool"` message with the answering `toolCallId` and the failure flag
// `isError` at the message level (the pre-v4 `role: "user"` /
// `content[0].type === "tool-result"` shape never occurs under v4: 2433 of 2433
// real result rows are `role: "tool"`, `content[0].type: "text"`). One helper,
// `toolResultOf`, is the single detector: it feeds the call -> result map (so
// call rows cite `-> result M` and result rows get their own
// `* tool-result (seq N)` line) and the 3.5 back-off. Before this fix the map
// was empty, so the digest cited calls with no result pointer and 3.5 was blind
// to results — the blindness that let a token-driven cut land inside a result
// run (the corruption 3.10 now floors). The detector is digest-side only: the
// 3.10 floor keeps its own authority at commit.
//
// The compiler is vendored (trimmed) from the upstream compaction compiler
// because preset-local plugin files are loaded dependency-free. Bump the `?v=`
// in the referencing row of agent.cordis.yml after editing this file.
//
// ── "saved tokens" is NET, the meter's freed figure is NET ──────────────────
// This plugin emits a `compaction/summary` event with `shadowedTokenCount` =
// Σ `estimateMessage` over the whole replaced span — the gross cost of the
// removed nodes, NOT subtracting the price of the new elide/replacement text.
// Each summary is bracketed by a v4 compaction lifecycle (`compaction/start`
// ... `compaction/end`, with `data.turn` = the OPEN turn of the session at
// commit time — `null` only between turns, a turn number for the mid-turn
// pre-step fold and the frame policy that follows it) so the strict read
// validation accepts it.
// That summary event MUST stay gross: the token-meter's surface fold subtracts
// the replacement itself (`deltaTokens = estimateMessage(replacement) −
// claim.tokens`), so a net summary would double-subtract. The plugin's own
// `saved N` log line, however, is now NET: it computes `netSaved =
// shadowedTokenCount − estimateMessage(replacementMessage)` in both the
// re-compose and attachment-fold branches, so the log no longer overstates
// freed space by the elide text's price and agrees with the meter's net figure.
// The token-meter computes the NET dominant figure: the projection fold
// (`foldSurfaceProjection` in @deepseek-ai/dsh-token-meter/lib/index.js) does
// `deltaTokens = estimateMessage(replacement) − claim.tokens`, and the
// positional fold (`foldSurfaceTokens` in lib/types/surface-fold.js) does
// `tokens(replacement) − Σ removed`. Both properly subtract the replacement
// text, and this plugin's vendored `estimateContent`/`estimateMessage`
// (`CHARS_PER_TOKEN=4`, `BLOCK_OVERHEAD=4`) exactly mirror the meter's, so the
// numbers agree. Net result: the "Messages"/`projectedTokens`/occupancy figures
// the UI uses DO account for the elide text, and the plugin's `saved N` log
// line now does too.
//
// ── abnormal / reasoning-only turn behavior ─────────────────────────────────
// The `turn/end` trigger treats abnormal ends (`error`, `max-tokens`,
// `aborted`, `blocked`) AND reasoning-only turns the same way: instead of
// skipping compaction entirely, it calls `runCompaction(agent,
// {keepLastSession:true})`, which folds `sessions.slice(0, -1)` — everything up
// to the previous turn — and keeps only the last session (the problematic turn)
// live so the interrupted reply / chain of thought survives a "Continue".
// `runCompaction(agent, opts)` gained the `opts.keepLastSession` flag; the
// `pendingWork()` list's last span is the current turn's session. For `blocked`
// (no new session started) the last session is the blocked turn's session and
// is kept. Normal turns still fold all sessions; attachment folding is
// unchanged. The per-turn consolidation (3.8) runs only on the NORMAL path.
//
// This `keepLastSession` path is gated behind the `compactOnAbnormal`
// config flag (default `false`). When the flag is `false`, an abnormal or
// reasoning-only turn end skips compaction entirely — past sessions are never
// compressed on a request failure. Set `compactOnAbnormal: true` in the
// plugin row's `config` to restore the original keep-last-session behavior.
//
// ── breakdown log + whitespace normalization ────────────────────────────────
// The `re-composed N surface nodes ...` log line carries a per-kind breakdown
// with plain labels (no "folded/removed" synonyms): `(tool calls: K, tool
// results: R, reasoning blocks: X, text lines: L, media links: M)`. The counts
// come from `compileNodes`' returned `stats` (`tools`, `results`,
// `reasoningRemoved`, `text`, `media`) — `tools` counts call rows and `results`
// result rows (3.11), so `K` stays the call count it always was and `R` is the
// new, previously invisible half of the fold. Separately, `joinCompiledEntries`
// runs the output through
// `normalizeWhitespace`, which collapses runs of blank lines to one, trims
// trailing spaces/tabs per line, and drops leading/trailing blank lines —
// intra-line space runs are deliberately untouched so code/indentation in kept
// text is not mangled. This is purely cosmetic for the model (same content,
// tighter formatting, marginally fewer tokens); recall links and `(seq N)` refs
// are preserved.

const name = "dsh-compaction-micro";
// `llm`/`tokenMeter` mirror dsh-compaction-basic's inject list: mid-turn
// pressure needs the harness context window (resolveModelInfo) and the meter's
// measure() on the session surface. Both are host-plane rows in the base
// bundle, so the host-plane micro row resolves them the same way basic does.
const inject = ["sessions", "agents", "llm", "tokenMeter"];

// ── vendored compiler subset ────────────────────────────────────────────────

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Strip carriage returns, ANSI escapes, and control bytes (never truncates). */
function sanitize(text) {
  if (typeof text !== "string") return "";
  let out = text;
  if (out.includes("\r")) out = out.replaceAll("\r", "");
  if (out.includes("\x1b")) out = out.replace(ANSI_RE, "");
  return out.replace(CTRL_RE, "");
}

function seqRef(seq) {
  return `seq ${seq}`;
}

/**
 * Default key argument fields to prefer when a tool call carries no
 * model-authored `description`. These mirror the concrete target the GUI
 * surfaces as the tool's caption (e.g. `Glob "*.ts"`, `Read src/foo.ts`), so
 * the compacted one-liner names the actual pattern / file instead of hiding it
 * behind a bare tool name. `bash` is deliberately absent: it normally carries a
 * `description`, and falling back to the full `command` would be too long.
 *
 * Overridable per-tool through the `toolKeyArgFields` plugin config: set a tool
 * to a new array of field names to replace its defaults, or to `null` / `[]` to
 * drop its key-field fallback entirely (the tool then labels only via a
 * model-authored `description`).
 */
const DEFAULT_TOOL_KEY_ARG_FIELDS = Object.freeze({
  glob: Object.freeze(["pattern", "path"]),
  grep: Object.freeze(["pattern", "path"]),
  read: Object.freeze(["file_path"]),
  write: Object.freeze(["file_path"]),
  edit: Object.freeze(["file_path"]),
  read_image: Object.freeze(["file_path"]),
  str_replace_editor: Object.freeze(["path"])
});

/**
 * Resolve the `toolKeyArgFields` config: a per-tool override map merged over the
 * defaults. Each entry maps a tool name to an ordered array of argument-field
 * names to prefer (first present wins); `null` / `[]` removes that tool's
 * fallback. Returns a frozen merged map.
 * @param config - the raw plugin config.
 * @returns a frozen `{ [toolName]: string[] }` map.
 */
function resolveToolKeyArgFields(config) {
  const user = config && config.toolKeyArgFields;
  if (user === undefined || user === null) return DEFAULT_TOOL_KEY_ARG_FIELDS;
  if (typeof user !== "object" || Array.isArray(user)) {
    throw new Error("MicroCompactionConfig: toolKeyArgFields must be an object mapping tool name -> array of field names");
  }
  const merged = { ...DEFAULT_TOOL_KEY_ARG_FIELDS };
  for (const [tool, fields] of Object.entries(user)) {
    if (fields === null || fields === undefined) {
      delete merged[tool];
      continue;
    }
    if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string")) {
      throw new Error(`MicroCompactionConfig: toolKeyArgFields[${tool}] must be an array of field-name strings`);
    }
    merged[tool] = Object.freeze([...fields]);
  }
  return Object.freeze(merged);
}

/**
 * Build the compact label for a tool-call block from its raw JSON arguments
 * string. Resolves in three steps:
 *   1. When the tool is in `toolKeyArgFields`, prefer its first present key
 *      field (pattern for glob/grep, file path for read/write/edit) — the same
 *      primary the GUI surfaces as the caption.
 *   2. When the tool is NOT in `toolKeyArgFields`, prefer the model-authored
 *      `description` (the UI caption, e.g. `Bash Syntax-check the plugin file`).
 *   3. When neither produced a label, fall back to the first string argument
 *      field (the same system approach the GUI uses for generic tool calls).
 * Returns undefined when the arguments are absent, unparseable, or carry no
 * usable label.
 * @param block - the tool-call block.
 * @param keyArgFields - resolved `{ toolName: fieldNames }` map.
 */
function toolCallLabel(block, keyArgFields) {
  if (block === null || typeof block !== "object") return undefined;
  const raw = block.arguments;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = keyArgFields[block.name];
  if (fields !== undefined) {
    // Prefer the first present key field (pattern for glob/grep, file path for
    // read/write/edit) — the same primary the GUI surfaces as the caption.
    for (const field of fields) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }
  // Tool not in `toolKeyArgFields`: prefer the model-authored `description`.
  const desc = parsed.description;
  if (typeof desc === "string" && desc.trim().length > 0) return desc.trim();
  // System fallback: the first string argument field (mirrors the GUI's generic
  // tool-call caption, e.g. `py_exec · <first field>`).
  for (const value of Object.values(parsed)) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

// ── vendored token heuristic (from @deepseek-ai/dsh-token-meter estimate.ts) ─
// The token-meter's surface fold subtracts a replacement's `shadowedTokenCount`
// from its running total. That count must be priced by the SAME fixed heuristic
// the fold used when it added each appended message, or the subtraction drifts.
// Vendored here (dependency-free) so the `compaction/summary` we emit before a
// replace prices the shadowed span identically to the meter's own appends.

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;

/** Heuristic token price of one content block (mirrors token-meter estimateContent). */
function estimateContent(blocks) {
  let tokens = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "text":
      case "reasoning":
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case "tool-call":
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN) + Math.ceil(block.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case "tool-result":
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD;
        break;
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
    }
  }
  return tokens;
}

/** Heuristic token price of one model-visible message (mirrors estimateMessage). */
function estimateMessage(message) {
  if (message === null || message === undefined || message.content === undefined) return 0;
  return estimateContent(message.content) + 4;
}

/**
 * The v4 tool-result identity of one node's derived message (3.11): the call it
 * answers plus its failure flag, or null when the node is not a tool result.
 * `deriveEventMessage` projects a `tool/result` event to its `data.message`,
 * which under the v4 format is `role: "tool"` carrying the answering
 * `toolCallId` and the `isError` flag at the message level, with the result
 * text in `content`. The pre-v4 shape this plugin used to test
 * (`role === "user"` with `content[0].type === "tool-result"`) is never
 * produced by the v4 format, which is why the call -> result map stayed empty.
 * This helper is the single detector for both the digest pointers and the 3.5
 * dangling-call back-off.
 * @param message - the derived message (may be null).
 * @returns `{ callId, isError }` or null.
 */
function toolResultOf(message) {
  if (message === null || message === undefined || message.role !== "tool") return null;
  if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) return null;
  return { callId: message.toolCallId, isError: message.isError === true };
}

/**
 * Compile one ordered surface region into re-composed entry strings.
 * @param nodes - ordered `{ seq, message }` projections (message may be null).
 * @param config - resolved compiler configuration.
 * @returns `{ entries, stats }` where each entry is `{ seq, text, kind }` and
 *   `stats` counts the folded surface by kind: `tools` (tool-call rows),
 *   `results` (tool-result rows), `text` (assistant text rows), `media`
 *   (image/document/other links), and `reasoningRemoved` (reasoning blocks
 *   dropped because `includeReasoning` is off).
 */
function compileNodes(nodes, config) {
  const includeReasoning = config.includeReasoning === true;
  const keyArgFields = config.toolKeyArgFields ?? DEFAULT_TOOL_KEY_ARG_FIELDS;
  const stats = { tools: 0, results: 0, text: 0, media: 0, reasoningRemoved: 0 };

  // map each tool call id -> seq of its result node (3.11 v4 detector), and
  // track which calls failed (the v4 result message carries the structured
  // `isError` flag, set by dsh-llm's createToolResultMessage and for
  // interrupted calls by dsh-session). Failed calls get a `, fail` marker on
  // their compacted row so the model still sees that the call was attempted and
  // did not succeed — the result text itself is only pointed at.
  const resultSeqByCallId = new Map();
  const failedCallIds = new Set();
  for (const node of nodes) {
    const result = toolResultOf(node.message);
    if (result === null) continue;
    resultSeqByCallId.set(result.callId, node.seq);
    if (result.isError) failedCallIds.add(result.callId);
  }

  const entries = [];
  let lastRole;
  let open = false;

  const roleHeader = (role) => {
    if (!open || lastRole !== role) {
      open = true;
      lastRole = role;
      return `[${role}]\n`;
    }
    return "";
  };

  for (const node of nodes) {
    const message = node.message;
    if (message === null || message === undefined || message.content === undefined) continue;
    if (toolResultOf(message) !== null) {
      // Every folded result row keeps a pointer of its own: the call row above
      // carries `-> result M` when the pair lies in the same fold, and this line
      // guarantees the row is recoverable when its call is outside the range (a
      // call already folded in an earlier pass). The body is NOT inlined — that
      // is exactly what the fold removes; recall is the way back to it.
      entries.push({ seq: node.seq, text: `${roleHeader("assistant")}* tool-result (${seqRef(node.seq)})`, kind: "tool" });
      stats.results++;
      continue;
    }
    if (message.role === "assistant") {
      let header = "";
      for (const block of message.content) {
        if (block.type === "text") {
          const text = sanitize(block.text ?? "");
          if (text.trim().length === 0) continue;
          header = roleHeader("assistant");
          entries.push({ seq: node.seq, text: `${header}${text} (${seqRef(node.seq)})`, kind: "text" });
          stats.text++;
          continue;
        }
        if (block.type === "reasoning") {
          if (!includeReasoning) {
            stats.reasoningRemoved++;
            continue;
          }
          const text = sanitize(block.text ?? "");
          if (text.trim().length === 0) continue;
          header = roleHeader("assistant");
          entries.push({ seq: node.seq, text: `${header}${text} (${seqRef(node.seq)})`, kind: "reasoning" });
          continue;
        }
        if (block.type === "tool-call") {
          const nm = block.name ?? "unknown";
          header = roleHeader("assistant");
          const label = toolCallLabel(block, keyArgFields);
          const rendered = label === undefined ? nm : `${nm} "${label}"`;
          const resultSeq = resultSeqByCallId.get(block.id);
          const ref = resultSeq === undefined ? seqRef(node.seq) : `${seqRef(node.seq)} -> result ${resultSeq}`;
          const failed = failedCallIds.has(block.id) ? ", fail" : "";
          entries.push({ seq: node.seq, text: `${header}* ${rendered} (${ref}${failed})`, kind: "tool" });
          stats.tools++;
          continue;
        }
        if (block.type === "image") {
          header = roleHeader("assistant");
          entries.push({ seq: node.seq, text: `${header}[image] (${seqRef(node.seq)})`, kind: "media" });
          stats.media++;
          continue;
        }
        if (block.type === "document") {
          header = roleHeader("assistant");
          entries.push({ seq: node.seq, text: `${header}[document] (${seqRef(node.seq)})`, kind: "media" });
          stats.media++;
          continue;
        }
        header = roleHeader("assistant");
        entries.push({ seq: node.seq, text: `${header}[${String(block.type)}] (${seqRef(node.seq)})`, kind: "media" });
        stats.media++;
      }
      continue;
    }
  }

  return { entries, stats };
}

/**
 * Collapse runs of blank lines and trailing whitespace in the joined text.
 * Multiple consecutive blank lines become one, each line's trailing spaces/tabs
 * are trimmed, and leading/trailing blank lines are dropped. Intra-line space
 * runs are deliberately left alone so code/indentation inside kept text is not
 * mangled. Purely cosmetic — the model reads the same content, just tighter.
 */
function normalizeWhitespace(text) {
  const lines = text.split("\n");
  const out = [];
  let blank = false;
  for (const line of lines) {
    const trimmed = line.replace(/[ \t]+$/g, "");
    if (trimmed.trim().length === 0) {
      if (!blank) out.push("");
      blank = true;
    } else {
      out.push(trimmed);
      blank = false;
    }
  }
  while (out.length > 0 && out[0].trim().length === 0) out.shift();
  while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
  return out.join("\n");
}

/** Join entries: consecutive tool rows with a single newline, else blank line. */
function joinCompiledEntries(entries) {
  let out = "";
  let previousKind;
  for (const entry of entries) {
    const kind = entry.kind;
    if (out.length > 0) out += previousKind === "tool" && kind === "tool" ? "\n" : "\n\n";
    out += entry.text;
    previousKind = kind;
  }
  return normalizeWhitespace(out);
}

/** Frame entries as the durable replacement content: plain text, no framing. */
function frameCompiled(entries) {
  return [{ type: "text", text: joinCompiledEntries(entries) }];
}

/**
 * The attachment blocks of a user message: every content block that is not
 * text, reasoning, tool-call, or tool-result (i.e. image, document, and any
 * other media/attachment type). Returns an empty array when there are none.
 * @param message - the user message.
 * @returns the attachment blocks.
 */
function userMessageAttachments(message) {
  if (message === null || message === undefined || message.content === undefined) return [];
  const attachments = [];
  for (const block of message.content) {
    if (block === null || block === undefined) continue;
    if (block.type === "text" || block.type === "reasoning" || block.type === "tool-call" || block.type === "tool-result") continue;
    attachments.push(block);
  }
  return attachments;
}

/**
 * Build the folded content for a user message whose attachments are replaced
 * by recall links. Text blocks are kept verbatim; each attachment block becomes
 * a `[image] (seq N)` / `[document] (seq N)` / `[<type>] (seq N)` link (the same
 * label format the compiler uses), so the original is recoverable via recall.
 * @param message - the original user message.
 * @param seq - the surface seq of the message (for the link).
 * @returns the replacement content blocks.
 */
function foldUserAttachments(message, seq) {
  const blocks = [];
  for (const block of message.content) {
    if (block === null || block === undefined) continue;
    if (block.type === "text") {
      blocks.push(block);
      continue;
    }
    if (block.type === "image") {
      blocks.push({ type: "text", text: `[image] (${seqRef(seq)})` });
      continue;
    }
    if (block.type === "document") {
      blocks.push({ type: "text", text: `[document] (${seqRef(seq)})` });
      continue;
    }
    blocks.push({ type: "text", text: `[${String(block.type)}] (${seqRef(seq)})` });
  }
  return blocks;
}

// ── mid-turn configuration knobs ─────────────────────────────────────────────

const PLUGIN_KIND = "plugin:dsh-compaction-micro";

/**
 * Package the engine's tool-pairing predicates come from (3.10). Resolved at
 * runtime through the composition loader, never a static import: the plugin
 * package does not depend on it and must not gain a dependency for a check.
 */
const SPEC_COMPACTION = "@deepseek-ai/dsh-compaction";

/** Frame kinds whose old copies are deleted from the surface (3.9). */
const DEDUPE_FRAME_KINDS = new Set(["skill-catalog", "agent-instructions", "goal", "runtime-context"]);

/** Phases that advance the fold boundary (everything else is decorative). */
const BOUNDARY_PHASES = new Set(["mid-turn", "session", "turn"]);

/** Positive integer config field (throws on invalid values at install time). */
function requirePositiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`MicroCompactionConfig: ${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Non-negative integer config field. */
function requireNonNegativeInt(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`MicroCompactionConfig: ${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Finite numeric ratio config field. */
function requireRatio(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`MicroCompactionConfig: ${label} must be a positive finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

// ── plugin logic ────────────────────────────────────────────────────────────

/** Deep-freeze helper for the replacement message (mirrors freezeMessage). */
function deepFreeze(value, seen) {
  if (value === null || typeof value !== "object") return value;
  const set = seen ?? new Set();
  if (set.has(value)) return value;
  set.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key], set);
  }
  return Object.freeze(value);
}

/** Fresh stable message id (Node ≥19 exposes globalThis.crypto). */
function newMessageId() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function apply(ctx, config = {}) {
  const log = (level, message) => {
    try {
      if (ctx.logger !== undefined && typeof ctx.logger[level] === "function") {
        ctx.logger[level](message);
        return;
      }
    } catch {
      /* fall through to console */
    }
    console.error(`dsh-compaction-micro ${message}`);
  };

  // Resolve the configurable fields once per plugin install. The mid-turn knobs
  // share their names/defaults with dsh-compaction-basic (thresholdRatio,
  // headroomTokens); chunkTokens/lockedChunks are micro-specific.
  const resolvedConfig = {
    includeReasoning: config.includeReasoning === true,
    toolKeyArgFields: resolveToolKeyArgFields(config),
    // When true, an abnormal turn end (`error`, `max-tokens`, `aborted`,
    // `blocked`) or a reasoning-only turn folds everything up to the previous
    // turn and keeps only the last (problematic) session live. When false
    // (default), compaction is skipped entirely on such turn ends so past
    // sessions are never compressed on a request failure.
    compactOnAbnormal: config.compactOnAbnormal === true,
    chunkTokens: requirePositiveInt(config.chunkTokens, 16384, "chunkTokens"),
    lockedChunks: requirePositiveInt(config.lockedChunks, 2, "lockedChunks"),
    thresholdRatio: requireRatio(config.thresholdRatio, 0.8, "thresholdRatio"),
    headroomTokens: requireNonNegativeInt(config.headroomTokens, 65536, "headroomTokens")
  };

  const chunkTokens = resolvedConfig.chunkTokens;
  const lockedChunks = resolvedConfig.lockedChunks;

  /** The `source.micro` metadata of a plugin replacement, or null. */
  const checkpointMetaOf = (event) => {
    if (event === undefined || event === null || event.type !== "user/message") return null;
    const source = event.data && event.data.source;
    if (source === null || source === undefined || source.kind !== PLUGIN_KIND) return null;
    return source.micro ?? null;
  };

  /** The visible text of a plugin node's message, or null when empty. */
  const checkpointTextOf = (message) => {
    if (message === null || message === undefined || message.content === undefined) return null;
    const texts = message.content.filter((b) => b !== null && b.type === "text" && typeof b.text === "string");
    const joined = texts.map((b) => b.text).join("\n").trim();
    return joined.length > 0 ? joined : null;
  };

  /** True for the nodes this plugin's own folds produced (any phase). */
  const isPluginNode = (event) => {
    if (event === undefined || event === null || event.type !== "user/message") return false;
    const source = event.data && event.data.source;
    return source !== null && source !== undefined && source.kind === PLUGIN_KIND;
  };

  /** True for plugin nodes that advance the fold boundary (not frame-deleted notes / attachment folds). */
  const isBoundaryNode = (event) => {
    if (!isPluginNode(event)) return false;
    const meta = checkpointMetaOf(event);
    return meta === null || BOUNDARY_PHASES.has(meta.phase);
  };

  /** True for foldable content nodes of a turn (assistant runs and tool results). */
  const isFoldableNode = (event) => {
    return event !== undefined && event !== null && (event.type === "assistant/message" || event.type === "tool/result");
  };

  /**
   * Project + price one surface node; non-projecting nodes price 0 (mirrors the
   * meter's fold). Returns `{ seq, event, message, price }` or null.
   */
  const projectNode = (session, seq) => {
    const event = session.eventAt ? session.eventAt(seq) : undefined;
    if (event === undefined || event === null) return null;
    const message = session.deriveEventMessage(event);
    return { seq, event, message, price: estimateMessage(message) };
  };

  /**
   * True when the LAST assistant message of the given turn carries only
   * `reasoning` blocks (no text, no tool calls, no media). Compacting such a
   * turn would drop the model's chain of thought and leave nothing useful, so
   * the plugin must not fold it.
   */
  const lastAssistantOnlyReasoning = (session, turn) => {
    const log = session.log;
    if (log === undefined || log === null) return false;
    let lastAssistant = null;
    for (const event of log) {
      if (event === undefined || event === null || event.type !== "assistant/message") continue;
      const data = event.data;
      if (data === undefined || data === null || data.turn !== turn) continue;
      lastAssistant = event;
    }
    if (lastAssistant === null) return false;
    const message = session.deriveEventMessage(lastAssistant);
    if (message === null || message === undefined || message.content === undefined) return false;
    const blocks = message.content;
    if (blocks.length === 0) return false;
    return blocks.every((block) => block !== null && block !== undefined && block.type === "reasoning");
  };

  /**
   * The index of the boundary node: the nearest (from the end) plugin node that
   * advances the fold boundary. Everything at or before it is already folded.
   * @param nodes - ordered surface seqs.
   * @param session - the session.
   * @returns the node index, or -1 when there is no boundary.
   */
  const boundaryIndex = (nodes, session) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const event = session.eventAt ? session.eventAt(nodes[i]) : undefined;
      if (isBoundaryNode(event)) return i;
    }
    return -1;
  };

  /** Node-position cost of the last tool result inside a node set (3.11: v4 detector). */
  const resultIndexByCallId = (stream) => {
    // stream entries: { idx, seq, event, message, price }; message may be null.
    const map = new Map();
    for (let i = 0; i < stream.length; i++) {
      const result = toolResultOf(stream[i].message);
      if (result !== null) map.set(result.callId, i);
    }
    return map;
  };

  /**
   * True when the assistant message carries a tool-call whose result is not
   * inside `stream[0..endIdx]` (its result sits later or is still pending).
   */
  const hasDanglingCall = (message, endIdx, resultIndexByCall) => {
    if (message === null || message === undefined || message.role !== "assistant" || message.content === undefined) return false;
    for (const block of message.content) {
      if (block === null || block === undefined || block.type !== "tool-call" || typeof block.id !== "string") continue;
      const resultIdx = resultIndexByCall.get(block.id);
      if (resultIdx === undefined || resultIdx > endIdx) return true;
    }
    return false;
  };

  /**
   * The pending compaction work for one session, found in a single forward pass
   * over the live tail (everything after our nearest replacement):
   *
   *   1. Walk the surface from the head backward to find OUR nearest content
   *      re-installation — the `user/message` replacement this plugin committed
   *      (`source.kind === "plugin:dsh-compaction-micro"`).
   *      Everything at or before it is already folded; everything after it is
   *      still live.
   *   2. From that boundary forward, split the live tail into consecutive
   *      assistant/tool sessions (split by user messages, which stay live), and
   *      collect every REAL user message the agent has already passed — a
   *      `user/message` with `source.kind === "user"` (not an injected frame),
   *      carrying attachments, and with a subsequent assistant/tool node after
   *      it (so the agent has answered it). The last, not-yet-answered user
   *      message is naturally excluded.
   *
   * @returns `{ sessions, attachmentUsers }` where `sessions` is the list of
   *   assistant/tool spans to fold (each ≥2 nodes) and `attachmentUsers` is the
   *   list of seqs of passed real user messages carrying attachments.
   */
  const pendingWork = (session) => {
    const nodes = Array.from(session.surface.nodes);
    if (nodes.length === 0) return { sessions: [], attachmentUsers: [] };

    // Pass 1: find our nearest boundary (index into `nodes`).
    const boundaryIdx = boundaryIndex(nodes, session);

    // Pass 2: one forward walk from the boundary — split sessions and collect
    // real user messages with attachments. Mid-turn/session checkpoints are
    // user/message nodes and split sessions exactly like real user messages.
    const sessions = [];
    const attachmentCandidates = [];
    let current = [];
    for (let i = boundaryIdx + 1; i < nodes.length; i++) {
      const seq = nodes[i];
      const event = session.eventAt ? session.eventAt(seq) : undefined;
      if (event === undefined || event === null) continue;
      if (event.type === "assistant/message" || event.type === "tool/result") {
        current.push(seq);
        continue;
      }
      if (current.length >= 2) sessions.push(current);
      current = [];
      if (event.type === "user/message") {
        const source = event.data && event.data.source;
        // Only real user messages (source.kind === "user"), never injected frames.
        if (source !== null && source !== undefined && source.kind === "user") {
          const message = session.deriveEventMessage(event);
          if (message !== null && message !== undefined && message.role === "user" && userMessageAttachments(message).length > 0) {
            attachmentCandidates.push(seq);
          }
        }
      }
    }
    if (current.length >= 2) sessions.push(current);

    // Keep only the candidates the agent has already passed: those with a
    // subsequent assistant/tool node after them. The last user message (no
    // response yet) is excluded.
    const attachmentUsers = attachmentCandidates.filter((seq) => {
      const idx = nodes.indexOf(seq);
      for (let i = idx + 1; i < nodes.length; i++) {
        const event = session.eventAt ? session.eventAt(nodes[i]) : undefined;
        if (event !== undefined && event !== null && (event.type === "assistant/message" || event.type === "tool/result")) {
          return true;
        }
      }
      return false;
    });

    return { sessions, attachmentUsers };
  };

  /**
   * True when every assistant message in the given span carries only
   * `reasoning` blocks (no text, no tool calls, no media). Folding such a
   * span would drop the model's chain of thought and leave nothing useful,
   * so it is skipped.
   */
  const spanOnlyReasoning = (session, span) => {
    let hasAssistant = false;
    for (const seq of span) {
      const event = session.eventAt ? session.eventAt(seq) : undefined;
      if (event === undefined || event === null || event.type !== "assistant/message") continue;
      hasAssistant = true;
      const message = session.deriveEventMessage(event);
      if (message === null || message === undefined || message.content === undefined) continue;
      const blocks = message.content;
      if (blocks.length === 0) continue;
      if (!blocks.every((block) => block !== null && block !== undefined && block.type === "reasoning")) return false;
    }
    return hasAssistant;
  };

  /**
   * The turn a compaction lifecycle committed right now belongs to: the open
   * turn derived from real session state — the last `turn/start` without a
   * matching `turn/end` — or null when no turn is open. The v4 log invariant
   * requires `compaction/start` and its paired `compaction/end` to name exactly
   * the open turn, so a fold made INSIDE a turn (the mid-turn pre-step path and
   * the frame policy that runs right after it) must not write the standalone
   * `turn: null`, which is correct only between turns.
   * @param session - the session.
   * @returns the open turn number, or null when no turn is open.
   */
  const openTurnOf = (session) => {
    let events;
    try {
      events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.log;
    } catch {
      return null;
    }
    if (events === undefined || events === null || typeof events[Symbol.iterator] !== "function") return null;
    let open = null;
    for (const event of events) {
      if (event === undefined || event === null) continue;
      if (event.type === "turn/start") open = event.data === undefined || event.data === null ? null : event.data.turn;
      else if (event.type === "turn/end") open = null;
    }
    return Number.isSafeInteger(open) ? open : null;
  };

  // ── tool-pairing oracle (3.10) ──────────────────────────────────────────────
  // The engine that cuts surfaces (`@deepseek-ai/dsh-compaction-basic`) only
  // cuts where no tool call is unanswered and refuses a surface where a
  // `tool/result` has no live `tool-call` ("corrupt surface"): it asks
  // `toolPairingBalancedBefore` / `toolPairingBalancedAfter` from
  // `@deepseek-ai/dsh-compaction`. A fold must use THAT notion, not a private
  // one. The helpers live in a package this plugin does not depend on, so they
  // are resolved at runtime through the composition loader (ctx.loader.import
  // resolves against ctx.baseUrl, the profile directory) — no static import,
  // no new dependency. Until the module is in hand the plugin does not fold at
  // all: an unchecked boundary is exactly the corruption this guard exists to
  // prevent, and the next trigger retries.
  let pairingHelpers = null;
  let pairingLoad = null;
  let pairingWarned = false;
  const pairing = () => {
    if (pairingHelpers !== null) return pairingHelpers;
    if (pairingLoad === null) {
      try {
        const loader = ctx.loader;
        if (loader === undefined || loader === null || typeof loader.import !== "function") {
          pairingLoad = Promise.resolve(undefined);
        } else {
          pairingLoad = Promise.resolve(loader.import(SPEC_COMPACTION)).then(
            (mod) => {
              if (mod !== null && mod !== undefined && typeof mod.toolPairingBalancedAfter === "function" && typeof mod.toolPairingBalancedBefore === "function") {
                pairingHelpers = mod;
                log("info", `tool-pairing oracle: ${SPEC_COMPACTION} helpers loaded (folds are boundary-checked)`);
              }
              return pairingHelpers;
            },
            (error) => {
              pairingLoad = null;
              log("warn", `tool-pairing oracle: ${SPEC_COMPACTION} unavailable (${error instanceof Error ? error.message : String(error)}); folds stay disabled`);
              return null;
            }
          );
        }
      } catch (error) {
        pairingLoad = null;
        log("warn", `tool-pairing oracle: ${SPEC_COMPACTION} unavailable (${error instanceof Error ? error.message : String(error)}); folds stay disabled`);
      }
    }
    return pairingHelpers;
  };

  /**
   * Ask the engine whether a cut is tool-pairing balanced. `undefined` means
   * the oracle cannot answer (not loaded, seq off the surface, or the surface
   * is already pairing-corrupt) — callers treat that as "do not fold", never
   * as "balanced".
   * @param fn - the engine predicate (`toolPairingBalancedBefore`/`After`).
   * @param session - the session.
   * @param seq - surface seq whose leading/trailing cut is checked.
   * @returns true/false from the engine, or undefined when it cannot answer.
   */
  const cutBalanced = (fn, session, seq) => {
    try {
      const answer = fn(session, seq);
      return answer === true ? true : answer === false ? false : undefined;
    } catch {
      return undefined;
    }
  };

  const oracleMissing = () => {
    if (!pairingWarned) {
      pairingWarned = true;
      log("warn", "tool-pairing oracle unavailable: skipping compaction folds (a fold boundary cannot be checked)");
    }
    return false;
  };

  /**
   * Both cuts of a span must be pairing balanced (3.10): the cut before its
   * first node and the cut after its last one. Only then is every tool
   * call/result pair wholly inside or wholly outside the span, so the fold can
   * leave neither an orphan result nor a permanently unanswered call — the two
   * shapes that stop the engine from cutting the surface ever again.
   * @param session - the session.
   * @param start - first shadowed surface seq.
   * @param end - last shadowed surface seq.
   * @param label - log label of the fold being guarded.
   * @returns true when the span may be committed.
   */
  const pairingSafeSpan = (session, start, end, label) => {
    const helpers = pairing();
    if (helpers === null) return oracleMissing();
    const before = cutBalanced(helpers.toolPairingBalancedBefore, session, start);
    if (before !== true) {
      log("warn", `${label}: refusing fold seqs ${start}-${end}: the cut before seq ${start} is not pairing balanced (${before === undefined ? "unverifiable" : "a tool call or result crosses it"})`);
      return false;
    }
    const after = cutBalanced(helpers.toolPairingBalancedAfter, session, end);
    if (after !== true) {
      log("warn", `${label}: refusing fold seqs ${start}-${end}: the cut after seq ${end} is not pairing balanced (${after === undefined ? "unverifiable" : "a tool call or result crosses it"})`);
      return false;
    }
    return true;
  };

  /**
   * Move a token-driven fold end onto the engine's nearest pairing-balanced
   * cut (3.10). Forward first (keep the fold as large as intended: the extra
   * nodes are the tail of a step whose head is already inside the range, and
   * they stay bounded by one extra locked chunk), backward second (fold less),
   * nothing when neither is acceptable — never a boundary that splits a pair.
   * @param session - the session.
   * @param stream - the foldable run in surface order (`{ seq, price }`).
   * @param endIdx - the token-driven end index into `stream`.
   * @returns `{ endIdx, moved, extraTokens }`, or null when no safe end exists.
   */
  const snapEndToBalancedCut = (session, stream, endIdx) => {
    const helpers = pairing();
    if (helpers === null) {
      oracleMissing();
      return null;
    }
    const after = (index) => cutBalanced(helpers.toolPairingBalancedAfter, session, stream[index].seq);
    const startCut = cutBalanced(helpers.toolPairingBalancedBefore, session, stream[0].seq);
    if (startCut !== true) {
      log("warn", `mid-turn: refusing to fold from seq ${stream[0].seq}: the cut before it is not pairing balanced (${startCut === undefined ? "unverifiable" : "a tool call or result crosses it"})`);
      return null;
    }
    if (after(endIdx) === true) return { endIdx, moved: false, extraTokens: 0 };

    let extraTokens = 0;
    for (let index = endIdx + 1; index < stream.length; index++) {
      extraTokens += stream[index].price || 0;
      if (after(index) === true) {
        const cap = chunkTokens * (lockedChunks + 1);
        if (extraTokens > cap) {
          log("warn", `mid-turn: pairing-safe fold end lies ${extraTokens} tokens ahead (cap ${cap}); fold skipped this pass`);
          return null;
        }
        return { endIdx: index, moved: true, extraTokens, from: stream[endIdx].seq, to: stream[index].seq };
      }
    }
    for (let index = endIdx - 1; index >= 0; index--) {
      if (after(index) !== true) continue;
      const keptTokens = stream.slice(0, index + 1).reduce((acc, node) => acc + (node.price || 0), 0);
      if (keptTokens < chunkTokens) return null;
      return { endIdx: index, moved: true, extraTokens: 0, from: stream[endIdx].seq, to: stream[index].seq, shrunk: true };
    }
    log("warn", `mid-turn: no pairing-balanced fold end at or before seq ${stream[endIdx].seq}; fold skipped this pass`);
    return null;
  };

  /**
   * Commit ONE replacement over a contiguous surface range with the compaction
   * lifecycle (start..summary..end), mirroring the existing turn/end machinery.
   * The lifecycle owner turn is the OPEN turn of the session at commit time
   * (`null` only for a fold committed between turns). The replacement message
   * is a plugin checkpoint (`source.micro` carries `meta` for the per-turn
   * consolidation, 3.8).
   * @param session - the session.
   * @param shadowed - ordered projected nodes `{ seq, event, message, price }`.
   * @param blocks - replacement content blocks.
   * @param meta - `source.micro` metadata (phase/turn/span/tokens/tools).
   * @param label - log label for the per-op breakdown.
   * @returns the replacement seq, or null when nothing was committed.
   */
  const commitReplacement = (session, shadowed, blocks, meta, label) => {
    if (shadowed.length === 0) return null;
    const shadowedSeqs = shadowed.map((n) => n.seq);
    const start = shadowedSeqs[0];
    const end = shadowedSeqs[shadowedSeqs.length - 1];
    const shadowedTokenCount = shadowed.reduce((acc, n) => acc + (n.price || 0), 0);
    if (shadowedTokenCount === 0 && blocks.length === 0) return null;

    // Tool-pairing floor (3.10): every fold path funnels through here, so this
    // is where the engine's balance contract is enforced — the cut before the
    // first shadowed node and the cut after the last one must both be
    // pairing balanced. A span that fails is not committed at all: leaving the
    // content live is always recoverable, an orphan result is not.
    if (!pairingSafeSpan(session, start, end, label)) return null;

    const source = meta === undefined || meta === null ? { kind: PLUGIN_KIND } : { kind: PLUGIN_KIND, micro: deepFreeze({ ...meta }) };
    const replacementMessage = deepFreeze({
      id: newMessageId(),
      role: "user",
      content: deepFreeze(blocks),
      source
    });

    const compactionId = newMessageId();
    const lifecycle = { compactionId, turn: openTurnOf(session) };
    const startEvent = session.append("compaction/start", lifecycle);
    const summaryEvent = session.append("compaction/summary", {
      compactionId,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount
    });

    const replacement = session.append("user/message", replacementMessage, {
      surfaceOp: { op: "replace", startSeq: start, endSeq: end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
    });
    session.append("compaction/end", lifecycle);

    const netSaved = shadowedTokenCount - estimateMessage(replacementMessage);
    log("info", `${label}: re-composed ${shadowedSeqs.length} surface nodes (seqs ${start}-${end}) into seq ${replacement.seq}; saved ${netSaved} net tokens (gross ${shadowedTokenCount})`);
    return replacement.seq;
  };

  /**
   * The mid-turn chunk window (3.3): the contiguous foldable run right after
   * our nearest boundary, sliced into `chunkTokens` chunks from the oldest
   * node. The last `lockedChunks` chunk-objects are the locked window (never
   * folded); everything older is foldable.
   * @param session - the session.
   * @returns `{ startIdx, endIdx, shadowed, foldableChunks }`, or null when the
   *   skip-guard fails (no complete foldable chunk older than the lock).
   */
  const chunkWindow = (session) => {
    const nodes = Array.from(session.surface.nodes);
    if (nodes.length === 0) return null;
    const boundaryIdx = boundaryIndex(nodes, session);

    // The contiguous foldable run of the current turn: nodes after the
    // boundary, skipping the non-foldable prefix (system prompt, injected
    // frames, the user's question — they stay live ABOVE the fold range), then
    // the run of `assistant/message | tool/result` nodes. A foreign node
    // INSIDE the run (mid-turn frame relay, user message) ends it — the range
    // must shadow nothing but foldable nodes. With no boundary yet (fresh
    // session, first fire) the run is simply the turn's whole foldable span.
    const stream = [];
    let streamTokens = 0;
    let started = false;
    for (let i = boundaryIdx + 1; i < nodes.length; i++) {
      const event = session.eventAt ? session.eventAt(nodes[i]) : undefined;
      if (isFoldableNode(event)) {
        started = true;
        const node = projectNode(session, nodes[i]);
        if (node === null) continue;
        stream.push(node);
        streamTokens += node.price;
        continue;
      }
      if (started) break;
      // leading non-foldable prefix (system prompt, frames, user question):
      // stays live above the range, skipped.
    }
    if (stream.length === 0) return null;

    // Chunk-object model: totalChunks = ceil(streamTokens / chunkTokens); the
    // last `lockedChunks` chunk-objects are locked. The first foldable full
    // chunk appears when streamTokens crosses lockedChunks * chunkTokens
    // (default 32768) — the exact two-full-chunks boundary stays locked
    // (skip-guard, foldableChunks = 0).
    const totalChunks = Math.ceil(streamTokens / chunkTokens);
    const foldableChunks = totalChunks - lockedChunks;
    if (foldableChunks <= 0) return null;
    const foldableTokens = foldableChunks * chunkTokens;

    // Nominal range end: include the node that crosses the foldable budget.
    let endIdx = -1;
    let acc = 0;
    for (let j = 0; j < stream.length; j++) {
      acc += stream[j].price;
      if (acc >= foldableTokens) {
        endIdx = j;
        break;
      }
    }
    if (endIdx === -1) endIdx = stream.length - 1;

    // Pairing back-off (3.5): never cut a tool call from its result. Drop
    // trailing assistant nodes whose call's result lies outside the range.
    // 3.11: the map is now built from the v4 result shape ("tool" role +
    // `toolCallId`), so this guard actually sees results; before the fix the
    // map was empty and the loop only ever backed off a trailing call row.
    const resultIndexByCall = resultIndexByCallId(stream);
    while (endIdx >= 0 && hasDanglingCall(stream[endIdx].message, endIdx, resultIndexByCall)) {
      endIdx--;
    }
    if (endIdx < 0) return null;

    // Tool-pairing snap (3.10): that back-off only guards a call whose row is
    // the LAST node of the range. A token-driven end can land inside a step's
    // result run while the call row sits far earlier — the fold then removes
    // the calls with part of their results and leaves the rest live, which is
    // the "corrupt surface" that stops the engine from ever compacting again.
    // Move the end onto the engine's own nearest balanced cut instead.
    const snap = snapEndToBalancedCut(session, stream, endIdx);
    if (snap === null) return null;
    if (snap.moved) {
      log("info", `mid-turn: pairing snap moved the fold end from seq ${snap.from} to seq ${snap.to} (+${snap.extraTokens} tokens${snap.shrunk ? ", shrunk" : ""}) so no tool call/result pair is split; nominal seq ${stream[endIdx].seq}`);
      endIdx = snap.endIdx;
      if (endIdx < 0) return null;
    }

    const startIdx = stream[0].idx;
    const shadowed = stream.slice(0, endIdx + 1).map((node) => ({
      seq: node.seq,
      event: node.event,
      message: node.message,
      price: node.price
    }));
    return { startIdx, endIdx, shadowed, foldableChunks, streamTokens };
  };

  /**
   * Mid-turn pressure fold at `agent/pre-step` (before basic). Fires when BOTH
   * conditions hold (Q26): the meter's total is at or above microThreshold
   * (the GOVERNING trigger, one `chunkTokens` below basic's threshold when both
   * use the same thresholdRatio/headroomTokens), and there is at least one
   * complete foldable chunk older than the locked window (skip-guard). The fold
   * is one batched replacement over ALL foldable chunks (3.7).
   */
  const runMidTurn = async (agent, turn, signal) => {
    try {
      const session = agent.session;
      if (session === undefined || session.surface === undefined || typeof session.eventAt !== "function") return;

      const meter = ctx.tokenMeter;
      const llm = ctx.llm;
      if (meter === undefined || llm === undefined) {
        // Harness services unavailable: mid-turn firing stays off, the turn/end
        // path keeps working (it needs no W/maxTokens).
        log("warn", "mid-turn firing disabled: harness tokenMeter/llm services not available");
        return;
      }

      // W (context window) and maxTokens come from the harness, mirroring
      // basic's pressure math (resolveModelInfo + durable request header).
      const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
      const headerConfig = header && header.config;
      if (!headerConfig || typeof headerConfig.provider !== "string" || headerConfig.provider.length === 0 || typeof headerConfig.model !== "string" || headerConfig.model.length === 0) return;
      const info = await llm.resolveModelInfo(headerConfig.provider, headerConfig.model, signal);
      if (signal !== undefined && signal.aborted) return;
      const windowTokens = info && info.context ? info.context.contextWindow : undefined;
      if (!Number.isInteger(windowTokens) || windowTokens <= 0) {
        log("info", `no context window for ${headerConfig.provider}/${headerConfig.model}; skipping mid-turn`);
        return;
      }
      const headerMax = Number.isSafeInteger(headerConfig.maxTokens) && headerConfig.maxTokens > 0 ? headerConfig.maxTokens : 0;
      const defaultMax = Number.isSafeInteger(info.defaultMaxTokens) && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : 0;
      const maxTokens = headerMax || defaultMax;
      const pressure = windowTokens - maxTokens - resolvedConfig.headroomTokens;
      if (pressure <= 0) return;
      const microThreshold = Math.floor(Math.min(windowTokens * resolvedConfig.thresholdRatio, pressure)) - chunkTokens;

      const measurement = meter.measure(session);
      const totalTokens = measurement.totalTokens;
      if (totalTokens < microThreshold) return;

      const win = chunkWindow(session);
      if (win === null) return;

      const nodes = win.shadowed.map((n) => ({ seq: n.seq, message: n.message }));
      const { entries, stats } = compileNodes(nodes, resolvedConfig);
      if (entries.length === 0) return;
      const blocks = frameCompiled(entries);

      const meta = {
        phase: "mid-turn",
        turn,
        span: [win.shadowed[0].seq, win.shadowed[win.shadowed.length - 1].seq],
        tokens: win.shadowed.reduce((acc, n) => acc + (n.price || 0), 0),
        tools: stats.tools
      };
      commitReplacement(session, win.shadowed, blocks, meta, `micro (mid-turn, pre-step, turn ${turn})`);
      deleteStaleFrames(session);
      log("info", `micro threshold state: total ${totalTokens} >= ${microThreshold} (${(100 * totalTokens / windowTokens).toFixed(1)}% of ${windowTokens}), foldable chunks ${win.foldableChunks}`);
    } catch (error) {
      log("warn", `mid-turn fold failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Per-turn consolidation (3.8): at a normal turn/end, fold the whole turn's
   * checkpoint block plus its remaining live content into ONE per-turn node,
   * capping checkpoint NODE overhead at O(turns). The node's content follows
   * the SAME fold semantics as every other fold (Q29): reasoning dropped, tool
   * call/result folded to pointers, everything else kept verbatim — the format
   * the compacting machinery produced before this session's changes (a plain
   * assistant text step stays as-is; no map card, no special final-answer
   * handling). Runs only when the turn's foldable span is contiguous from the
   * last per-turn node (no user message / frame in between); otherwise the
   * caller falls back to per-session folds.
   * @returns true when the consolidation committed.
   */
  const consolidateTurn = (session, turn) => {
    const nodes = Array.from(session.surface.nodes);
    if (nodes.length === 0) return false;

    // The consolidation boundary is the LAST per-turn consolidation node; the
    // whole live tail after it (this turn's mid-turn checkpoints + live
    // content) is folded into the next node. When none exists yet, the boundary
    // is the nearest boundary node (fresh sessions fold everything since it).
    let boundaryIdx = -1;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const event = session.eventAt ? session.eventAt(nodes[i]) : undefined;
      if (!isPluginNode(event)) continue;
      const meta = checkpointMetaOf(event);
      if (meta !== null && meta.phase === "turn") {
        boundaryIdx = i;
        break;
      }
      if (meta === null) {
        // Legacy checkpoint (pre-metadata): treat as a per-session boundary.
        boundaryIdx = i;
        break;
      }
    }

    // The contiguous run of fold content after the boundary: foldable nodes and
// checkpoints of foldable phases (mid-turn / session / turn). Decorative
// plugin notes (frame-deleted, attachment folds) are skipped as prefix — they
// stay live and must not start the run, or a user question below them would
// break the run forever. A foreign node INSIDE the run (mid-turn frame relay,
// user message) ends it, and the consolidation is skipped in that rare
// interleaved layout.
    const run = [];
    let started = false;
    for (let i = boundaryIdx + 1; i < nodes.length; i++) {
      const event = session.eventAt ? session.eventAt(nodes[i]) : undefined;
      if (isFoldableNode(event) || isBoundaryNode(event)) {
        started = true;
        const node = projectNode(session, nodes[i]);
        if (node !== null) run.push(node);
        continue;
      }
      if (started) break;
      // leading non-foldable prefix (system prompt, frames, user question,
      // decorative plugin notes): stays live below the replaced range.
    }
    if (run.length === 0) return false;
    if (!run.some((n) => isFoldableNode(n.event))) return false;

    // Content = the span's foldable nodes compiled with the standard semantics
    // (assistant text verbatim under `[assistant]` headers, calls/results ->
    // pointers, reasoning dropped), interleaved in surface order with the
    // already-compiled mid-turn checkpoints carried over verbatim. Sub-runs are
    // compiled separately: a checkpoint never splits a call -> result pair (a
    // fold commits only after both are on the surface), so pairing stays intact.
    const entries = [];
    const foldRun = [];
    let tools = 0;
    const flushFold = () => {
      if (foldRun.length === 0) return;
      const { entries: compiled, stats } = compileNodes(foldRun, resolvedConfig);
      tools += stats.tools;
      for (const entry of compiled) entries.push(entry);
      foldRun.length = 0;
    };
    for (const node of run) {
      if (isPluginNode(node.event)) {
        flushFold();
        const text = checkpointTextOf(node.message);
        if (text !== null) entries.push({ seq: node.seq, text, kind: "text" });
      } else {
        foldRun.push(node);
      }
    }
    flushFold();
    if (entries.length === 0) return false;
    const blocks = frameCompiled(entries);
    if (blocks.length === 0 || blocks[0].text.length === 0) return false;

    let tokens = 0;
    for (const node of run) {
      const meta = checkpointMetaOf(node.event);
      if (meta !== null) {
        if (Number.isSafeInteger(meta.tokens)) tokens += meta.tokens;
        if (Number.isSafeInteger(meta.tools)) tools += meta.tools;
      } else {
        tokens += node.price || 0;
      }
    }
    const meta = {
      phase: "turn",
      turn: Number.isSafeInteger(turn) ? turn : 0,
      span: [run[0].seq, run[run.length - 1].seq],
      tokens,
      tools
    };
    commitReplacement(session, run, blocks, meta, "micro (turn/end consolidation)");
    return true;
  };

  /**
   * Frame policy (3.9): delete old copies of the dedupe-able injected frames
   * (skill-catalog, agent-instructions, goal, runtime-context), keeping only
   * the LATEST version per frame type. Real user messages and non-dedupe live
   * messages (agent-message relays, tool-jobs, session-reference,
   * subagent-settled) always stay. The durable log keeps the originals
   * (recall works).
   */
  const deleteStaleFrames = (session) => {
    try {
      const nodes = Array.from(session.surface.nodes);
      // group by frame kind, in surface order
      const byKind = new Map();
      for (let i = 0; i < nodes.length; i++) {
        const event = session.eventAt ? session.eventAt(nodes[i]) : undefined;
        if (event === undefined || event === null || event.type !== "user/message") continue;
        const source = event.data && event.data.source;
        if (source === null || source === undefined || !DEDUPE_FRAME_KINDS.has(source.kind)) continue;
        // never touch the latest copy per kind
        let list = byKind.get(source.kind);
        if (list === undefined) {
          list = [];
          byKind.set(source.kind, list);
        }
        list.push({ idx: i, seq: nodes[i], event });
      }
      for (const [kind, list] of byKind) {
        if (list.length < 2) continue;
        const latest = list[list.length - 1];
        for (const stale of list.slice(0, -1)) {
          const message = session.deriveEventMessage(stale.event);
          const node = { seq: stale.seq, event: stale.event, message, price: estimateMessage(message) };
          const blocks = [{ type: "text", text: `[compaction: older ${kind} frame (${seqRef(stale.seq)}) removed; latest kept (${seqRef(latest.seq)})]` }];
          const meta = { phase: "frame-deleted", kind, span: [stale.seq, stale.seq] };
          const replacementSeq = commitReplacement(session, [node], blocks, meta, `micro (frame policy, ${kind})`);
          if (replacementSeq !== null) {
            log("info", `deleted stale ${kind} frame seq ${stale.seq} (latest seq ${latest.seq}) -> seq ${replacementSeq}`);
          }
        }
      }
    } catch (error) {
      log("warn", `frame deletion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runCompaction = (agent, opts = {}) => {
    try {
      const session = agent.session;
      if (session === undefined || session.surface === undefined || typeof session.eventAt !== "function") {
        log("warn", `Failed to run, session object keys: ${Object.keys(session)}`);
        return;
      }

      const { sessions, attachmentUsers } = pendingWork(session);
      if (sessions.length === 0 && attachmentUsers.length === 0) return;

      // Normal turn end: try the per-turn consolidation (3.8) first. It only
      // runs when the turn's foldable span is contiguous from the last per-turn
      // summary; otherwise (or when keepLastSession is set) fall back to the
      // per-session folds below.
      let replaced = 0;
      if (!opts.keepLastSession) {
        if (consolidateTurn(session, opts.turn)) replaced = 1;
      }

      if (replaced === 0) {
        // When `keepLastSession` is set (abnormal / reasoning-only turn end), fold
        // everything up to the previous turn and leave the last session live so
        // the interrupted reply / chain of thought survives for a "Continue".
        const foldSessions = opts.keepLastSession ? sessions.slice(0, -1) : sessions;
        if (opts.keepLastSession && sessions.length > 0) {
          const kept = sessions[sessions.length - 1];
          log("info", `keepLastSession: keeping session (seqs ${kept[0]}-${kept[kept.length - 1]}) live; folding ${foldSessions.length} prior session(s)`);
        }

        for (const span of foldSessions) {
          if (spanOnlyReasoning(session, span)) {
            log("info", `session (seqs ${span[0]}-${span[span.length - 1]}) is reasoning-only; no compaction`);
            continue;
          }

          // project each surface node to a message; skip non-projecting nodes.
          const shadowed = [];
          for (const seq of span) {
            const node = projectNode(session, seq);
            if (node !== null) shadowed.push(node);
          }
          if (shadowed.length === 0) continue;

          const nodes = shadowed.map((n) => ({ seq: n.seq, message: n.message }));
          const { entries, stats } = compileNodes(nodes, resolvedConfig);
          if (entries.length === 0) continue;
          const blocks = frameCompiled(entries);

          const start = shadowed[0].seq;
          const end = shadowed[shadowed.length - 1].seq;
          const turnOfSpan = Number.isSafeInteger(opts.turn) ? opts.turn : (shadowed[0].event.data && shadowed[0].event.data.turn);
          const meta = {
            phase: opts.keepLastSession ? "session" : "session",
            turn: Number.isSafeInteger(turnOfSpan) ? turnOfSpan : 0,
            span: [start, end],
            tokens: shadowed.reduce((acc, n) => acc + (n.price || 0), 0),
            tools: stats.tools
          };
          const replacementSeq = commitReplacement(session, shadowed, blocks, meta, `micro (turn/end, session seqs ${start}-${end})`);
          if (replacementSeq !== null) {
            replaced++;
            log("info", `re-composed ${shadowed.length} surface nodes (seqs ${start}-${end}) into seq ${replacementSeq}; tool calls: ${stats.tools}, tool results: ${stats.results}, reasoning blocks: ${stats.reasoningRemoved}, text lines: ${stats.text}, media links: ${stats.media}`);
          }
        }
      }

      // Fold attachments in every real user message the agent has already passed
      // into recall links, keeping the text.
      for (const attachmentUser of attachmentUsers) {
        const event = session.eventAt ? session.eventAt(attachmentUser) : undefined;
        if (event === undefined || event === null) continue;
        const message = session.deriveEventMessage(event);
        if (message === null || message === undefined || message.content === undefined) continue;
        const attachments = userMessageAttachments(message);
        if (attachments.length === 0) continue;

        const node = { seq: attachmentUser, event, message, price: estimateMessage(message) };
        const blocks = deepFreeze(foldUserAttachments(message, attachmentUser));
        // Tool-pairing floor (3.10): same contract as commitReplacement, which
        // this path bypasses because it writes its own lifecycle.
        if (!pairingSafeSpan(session, attachmentUser, attachmentUser, "micro (attachment fold)")) continue;
        const replacementMessage = deepFreeze({
          id: newMessageId(),
          role: "user",
          content: blocks,
          source: { kind: PLUGIN_KIND }
        });

        const compactionId = newMessageId();
        const lifecycle = { compactionId, turn: openTurnOf(session) };
        const startEvent = session.append("compaction/start", lifecycle);
        const summaryEvent = session.append("compaction/summary", {
          compactionId,
          shadowedRange: { start: attachmentUser, end: attachmentUser },
          shadowedSeqs: [attachmentUser],
          shadowedTokenCount: node.price
        });

        const replacement = session.append("user/message", replacementMessage, {
          surfaceOp: { op: "replace", startSeq: attachmentUser, endSeq: attachmentUser },
          sourceEventSeqs: [startEvent.seq, summaryEvent.seq, attachmentUser]
        });
        session.append("compaction/end", lifecycle);

        const netSaved = node.price - estimateMessage(replacementMessage);
        log("info", `folded ${attachments.length} attachment(s) in user message seq ${attachmentUser} into seq ${replacement.seq}; saved ${netSaved} tokens`);
        replaced++;
      }

      // Frame policy: delete stale injected frame copies if any.
      deleteStaleFrames(session);

      // The replacements are persisted by the engine's own write-behind
      // (SessionWriteBehind drains the buffer on its 200ms deadline and on
      // session dispose). We deliberately do NOT call ctx.sessions.flush here:
      // an explicit flush during an abnormal turn end (interrupted/aborted)
      // forces a durable write while the tool-delta stream is still open, which
      // can reorder buffered deltas after the turn's closing events and corrupt
      // the seq sequence. Letting the engine flush at its own quiescent point
      // keeps the seq order intact.
    } catch (error) {
      log("warn", `compaction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Start resolving the pairing oracle NOW (3.10). `apply` runs when the plugin
  // mounts — long before the first fold — so the first trigger already holds the
  // helpers instead of skipping one fold while the import settles; a fold
  // attempted before they arrive is refused (fail-closed), never unchecked.
  pairing();

  // ── mid-turn trigger: agent/pre-step, BEFORE basic ─────────────────────────
  // The host-plane listener registers before the preset-plane basic listener,
  // and `{ prepend: true }` pins the order as belt-and-suspenders (3.1). The
  // fold commits synchronously inside this handler (no microtask — none of
  // `session.append` is open at pre-step, and deferring would let basic's
  // pressure measurement see the PRE-fold surface and double-compact). The
  // waterfall waits for this listener before calling the next one, so basic
  // always measures the post-fold surface on the same step.
  ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
    try {
      await runMidTurn(agent, turn, signal);
    } catch (error) {
      log("warn", `mid-turn pre-step handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return next();
  }, { prepend: true });

  // ── trigger: compact once per completed request ───────────────────────────
  // Anchor on `turn/end` (a `session/event`), which the agent loop appends in
  // the turn's `finally` AFTER every assistant message is committed, so the
  // surface is complete. Every assistant/tool session since our last
  // replacement is folded; user messages and injected frames stay live.
  //
  // When the turn ended abnormally — `error` (request failed), `max-tokens`
  // ("Output token limit reached": reply cut off), `aborted` (cancelled
  // mid-turn), `blocked` (rejected before any step ran) — or when the last
  // assistant message of a completed turn is reasoning only, fold everything up
  // to the previous turn and keep only the last (problematic) session live so
  // the interrupted reply / chain of thought survives for a "Continue" prompt.
  ctx.on("session/event", (session, event) => {
    try {
      if (event.type !== "turn/end") return;
      const reason = event.data && event.data.reason;
      const kind = reason && reason.kind;
      const turn = event.data && event.data.turn;
      const abnormal = kind === "error" || kind === "max-tokens" || kind === "aborted" || kind === "blocked";
      const reasoningOnly = lastAssistantOnlyReasoning(session, turn);
      const agent = ctx.agents.get(session.id);
      if (agent === undefined) return;
      // `session/event` fires synchronously INSIDE `session.append("turn/end", …)`,
      // while that append is still being published. `runCompaction` itself calls
      // `session.append`, which is forbidden while another append is open
      // ("session append cannot reenter while another append is being published").
      // Defer the compaction to a microtask so the `turn/end` publication closes
      // first; the surface is already complete by then.
      queueMicrotask(() => {
        try {
          // A request that did not end successfully — `error` (request failed),
          // `max-tokens` (reply cut off), `aborted` (cancelled mid-turn),
          // `blocked` (rejected before any step ran) — or a reasoning-only turn
          // (last message is just a chain of thought) folds everything up to the
          // previous turn and keeps only the last (problematic) session live so
          // the interrupted reply / chain of thought survives for a "Continue".
          if (abnormal || reasoningOnly) {
            if (resolvedConfig.compactOnAbnormal) {
              log("info", `turn ${turn} ended ${abnormal ? `with ${kind}` : "reasoning-only"}: folding up to previous turn, keeping last session`);
              runCompaction(agent, { keepLastSession: true, turn });
            } else {
              log("info", `turn ${turn} ended ${abnormal ? `with ${kind}` : "reasoning-only"}: compactOnAbnormal disabled, skipping compaction`);
            }
          } else {
            runCompaction(agent, { turn });
          }
        } catch {
          /* never break the driver */
        }
      });
    } catch {
      /* never break the driver */
    }
  });
}

export { apply, inject, name };