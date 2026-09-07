// micro-compaction.js
// Cordis plugin for the kb preset: per-request trajectory re-composition.
//
// After every completed agent request (anchored on the `turn/end` event), every
// assistant-turn session since our last content re-installation is re-composed
// into a compact, recall-linked view. Each session (a contiguous run of
// assistant/message and tool/result nodes) is folded by its own replace, so
// user messages and injected frames between sessions stay live:
//   - tool calls      -> `* name "description" (seq N -> result M)`  (name plus
//                        the model-authored `description` from the arguments,
//                        when present; no raw argument blobs). A call whose
//                        result carries the structured `isError` flag gets a
//                        `, fail` marker so the model still sees the call was
//                        attempted and did not succeed.
//   - tool results    -> collapsed into the call's `-> result M` pointer;
//                        an unmatched result keeps its own `* tool-result (seq N)`
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
// `source.plugin === "dsh-compaction-micro"`); everything at or before it is
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
// The compiler is vendored (trimmed) from the upstream compaction compiler
// because preset-local plugin files are loaded dependency-free. Bump the `?v=`
// in the referencing row of agent.cordis.yml after editing this file.
//
// ── "saved tokens" is NET, the meter's freed figure is NET ──────────────────
// This plugin emits a `compaction/summary` event with `shadowedTokenCount` =
// Σ `estimateMessage` over the whole replaced span — the gross cost of the
// removed nodes, NOT subtracting the price of the new elide/replacement text.
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
// unchanged.
//
// This `keepLastSession` path is gated behind the `compactOnAbnormal`
// config flag (default `false`). When the flag is `false`, an abnormal or
// reasoning-only turn end skips compaction entirely — past sessions are never
// compressed on a request failure. Set `compactOnAbnormal: true` in the
// plugin row's `config` to restore the original keep-last-session behavior.
//
// ── breakdown log + whitespace normalization ────────────────────────────────
// The `re-composed N surface nodes ...` log line carries a per-kind breakdown
// with plain labels (no "folded/removed" synonyms): `(tool calls: K, reasoning
// blocks: R, text lines: L, media links: M)`. The counts come from
// `compileNodes`' returned `stats` (`tools`, `reasoningRemoved`, `text`,
// `media`). Separately, `joinCompiledEntries` runs the output through
// `normalizeWhitespace`, which collapses runs of blank lines to one, trims
// trailing spaces/tabs per line, and drops leading/trailing blank lines —
// intra-line space runs are deliberately untouched so code/indentation in kept
// text is not mangled. This is purely cosmetic for the model (same content,
// tighter formatting, marginally fewer tokens); recall links and `(seq N)` refs
// are preserved.

const name = "dsh-compaction-micro";
const inject = ["sessions", "agents"];

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
 * Compile one ordered surface region into re-composed entry strings.
 * @param nodes - ordered `{ seq, message }` projections (message may be null).
 * @param config - resolved compiler configuration.
 * @returns `{ entries, stats }` where each entry is `{ seq, text, kind }` and
 *   `stats` counts the folded surface by kind: `tools` (tool-call / tool-result
 *   rows), `text` (assistant text rows), `media` (image/document/other links),
 *   and `reasoningRemoved` (reasoning blocks dropped because `includeReasoning`
 *   is off).
 */
function compileNodes(nodes, config) {
  const includeReasoning = config.includeReasoning === true;
  const keyArgFields = config.toolKeyArgFields ?? DEFAULT_TOOL_KEY_ARG_FIELDS;
  const stats = { tools: 0, text: 0, media: 0, reasoningRemoved: 0 };

  // map each tool call id -> seq of its result node (result pointer), and track
  // which calls failed (result block carries the structured `isError` flag, set
  // by dsh-llm's createToolResultMessage and for interrupted calls by
  // dsh-session). Failed calls get a `, fail` marker on their compacted row so
  // the model still sees that the call was attempted and did not succeed — the
  // result text itself is already collapsed into the `-> result M` pointer.
  const resultSeqByCallId = new Map();
  const failedCallIds = new Set();
  for (const node of nodes) {
    const message = node.message;
    if (message === null || message === undefined || message.role !== "user" || message.content === undefined) continue;
    const first = message.content[0];
    if (first !== undefined && first.type === "tool-result" && typeof first.toolCallId === "string") {
      resultSeqByCallId.set(first.toolCallId, node.seq);
      if (first.isError === true) failedCallIds.add(first.toolCallId);
    }
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
    if (message.role === "user") {
      const first = message.content[0];
      if (first !== undefined && first.type === "tool-result") {
        // A matched result is consumed into the call's `-> result M` pointer;
        // an unmatched result keeps its own link so it never vanishes silently.
        const consumed = resultSeqByCallId.get(first.toolCallId) === node.seq;
        if (!consumed) {
          entries.push({ seq: node.seq, text: `${roleHeader("assistant")}* tool-result (${seqRef(node.seq)})`, kind: "tool" });
          stats.tools++;
        }
        continue;
      }
      // Only tool/result user nodes reach here (real user messages and injected
      // frames are never folded), so nothing else needs handling.
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

  // Resolve the configurable key-argument fields once per plugin install.
  const resolvedConfig = {
    includeReasoning: config.includeReasoning === true,
    toolKeyArgFields: resolveToolKeyArgFields(config),
    // When true, an abnormal turn end (`error`, `max-tokens`, `aborted`,
    // `blocked`) or a reasoning-only turn folds everything up to the previous
    // turn and keeps only the last (problematic) session live. When false
    // (default), compaction is skipped entirely on such turn ends so past
    // sessions are never compressed on a request failure.
    compactOnAbnormal: config.compactOnAbnormal === true
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
   * The pending compaction work for one session, found in a single forward pass
   * over the live tail (everything after our nearest replacement):
   *
   *   1. Walk the surface from the head backward to find OUR nearest content
   *      re-installation — the `user/message` replacement this plugin committed
   *      (`source.kind === "plugin"`, `source.plugin === "dsh-compaction-micro"`).
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

    // Pass 1: find our nearest replacement boundary (index into `nodes`).
    let boundaryIdx = 0;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const seq = nodes[i];
      const event = session.eventAt ? session.eventAt(seq) : undefined;
      if (event === undefined || event === null || event.type !== "user/message") continue;
      const source = event.data && event.data.source;
      if (source !== null && source !== undefined && source.kind === "plugin" && source.plugin === "dsh-compaction-micro") {
        boundaryIdx = i + 1;
        break;
      }
    }

    // Pass 2: one forward walk from the boundary — split sessions and collect
    // real user messages with attachments.
    const sessions = [];
    const attachmentCandidates = [];
    let current = [];
    for (let i = boundaryIdx; i < nodes.length; i++) {
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
   * True when every assistant message in the given session carries only
   * `reasoning` blocks (no text, no tool calls, no media). Folding such a
   * session would drop the model's chain of thought and leave nothing useful,
   * so it is skipped.
   */
  const sessionOnlyReasoning = (session, span) => {
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

  const runCompaction = (agent, opts = {}) => {
    try {
      const session = agent.session;
      if (session === undefined || session.surface === undefined || typeof session.eventAt !== "function") {
        log("warn", `Failed to run, session object keys: ${Object.keys(session)}`);
        return;
      }

      const { sessions, attachmentUsers } = pendingWork(session);
      if (sessions.length === 0 && attachmentUsers.length === 0) return;

      // When `keepLastSession` is set (abnormal / reasoning-only turn end), fold
      // everything up to the previous turn and leave the last session live so
      // the interrupted reply / chain of thought survives for a "Continue".
      const foldSessions = opts.keepLastSession ? sessions.slice(0, -1) : sessions;
      if (opts.keepLastSession && sessions.length > 0) {
        const kept = sessions[sessions.length - 1];
        log("info", `keepLastSession: keeping session (seqs ${kept[0]}-${kept[kept.length - 1]}) live; folding ${foldSessions.length} prior session(s)`);
      }

      let replaced = 0;
      for (const span of foldSessions) {
        if (sessionOnlyReasoning(session, span)) {
          log("info", `session (seqs ${span[0]}-${span[span.length - 1]}) is reasoning-only; no compaction`);
          continue;
        }

        // project each surface node to a message; skip non-projecting nodes.
        const nodes = [];
        const shadowedSeqs = [];
        let shadowedTokenCount = 0;
        for (const seq of span) {
          const event = session.eventAt ? session.eventAt(seq) : undefined;
          if (event === undefined || event === null) continue;
          shadowedSeqs.push(seq);
          const message = session.deriveEventMessage(event);
          // Price the span with the same heuristic the token-meter fold used when
          // it appended each node, so the summary's subtraction exactly reverses
          // the meter's accumulated total (null projections priced 0, as in the fold).
          shadowedTokenCount += estimateMessage(message);
          if (message !== null && message !== undefined) {
            nodes.push({ seq, message });
          }
        }

        if (nodes.length === 0 || shadowedSeqs.length === 0) continue;

        const { entries, stats } = compileNodes(nodes, resolvedConfig);
        if (entries.length === 0) continue;
        const blocks = frameCompiled(entries);

        const start = shadowedSeqs[0];
        const end = shadowedSeqs[shadowedSeqs.length - 1];

        // Net freed tokens: the gross shadowed span minus the price of the
        // replacement text we re-installed (mirrors the token-meter's fold,
        // which subtracts the replacement). Computed before the message is
        // built so the `notice` summary can cite it.
        const netSaved = shadowedTokenCount - estimateMessage({ content: blocks });

        // commit the model-free replacement (no token metering: no budgets).
        // `form: "notice"` + `summary` let the Chat UI surface a one-line
        // micro-compaction account (with the net saved tokens) on the collapsed
        // row instead of the generic "Context injection" label alone.
        const replacementMessage = deepFreeze({
          id: newMessageId(),
          role: "user",
          content: deepFreeze(blocks),
          source: {
            kind: "plugin",
            plugin: "dsh-compaction-micro",
            form: "notice",
            summary: `Micro-compaction: removed ${netSaved} tokens`
          }
        });

        // Arm the token-meter's shadow-price claim: the `compaction/summary`
        // event immediately before the replace states the heuristic price of the
        // exact replaced range, so the meter's surface fold subtracts it and the
        // UI's Messages figure shrinks with this compaction.
        session.append("compaction/summary", {
          shadowedRange: { start, end },
          shadowedSeqs: [...shadowedSeqs],
          shadowedTokenCount
        });

        const replacement = session.append("user/message", replacementMessage, {
          surfaceOp: { op: "replace", start, end },
          sourceEventSeqs: shadowedSeqs
        });

        // The `compaction/summary` above stays gross — the meter subtracts the
        // replacement itself; `netSaved` (computed above) is the net figure.
        log("info", `re-composed ${shadowedSeqs.length} surface nodes (seqs ${start}-${end}) into seq ${replacement.seq}; saved ${netSaved} tokens (tool calls: ${stats.tools}, reasoning blocks: ${stats.reasoningRemoved}, text lines: ${stats.text}, media links: ${stats.media})`);
        replaced++;
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

        const blocks = deepFreeze(foldUserAttachments(message, attachmentUser));
        const shadowedSeqs = [attachmentUser];
        const shadowedTokenCount = estimateMessage(message);

        // Net freed tokens, computed before the message is built so the
        // `notice` summary can cite it (mirrors the token-meter's fold).
        const netSaved = shadowedTokenCount - estimateMessage({ content: blocks });

        const replacementMessage = deepFreeze({
          id: newMessageId(),
          role: "user",
          content: blocks,
          source: {
            kind: "plugin",
            plugin: "dsh-compaction-micro",
            form: "notice",
            summary: `Micro-compaction: removed ${netSaved} tokens`
          }
        });

        session.append("compaction/summary", {
          shadowedRange: { start: attachmentUser, end: attachmentUser },
          shadowedSeqs: [...shadowedSeqs],
          shadowedTokenCount
        });

        const replacement = session.append("user/message", replacementMessage, {
          surfaceOp: { op: "replace", start: attachmentUser, end: attachmentUser },
          sourceEventSeqs: shadowedSeqs
        });

        log("info", `folded ${attachments.length} attachment(s) in user message seq ${attachmentUser} into seq ${replacement.seq}; saved ${netSaved} tokens`);
        replaced++;
      }

      if (replaced === 0) return;

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
              runCompaction(agent, { keepLastSession: true });
            } else {
              log("info", `turn ${turn} ended ${abnormal ? `with ${kind}` : "reasoning-only"}: compactOnAbnormal disabled, skipping compaction`);
            }
          } else {
            runCompaction(agent);
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