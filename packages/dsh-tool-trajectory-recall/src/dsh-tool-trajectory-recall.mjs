// dsh-tool-trajectory-recall.mjs
// Cordis plugin: model-facing same-session recall tools (`recall` restore +
// `search` grep) over the durable session log.
//
// This is the recall/search half of the upstream compaction plugin, split out
// into its own dependency-free plugin so the bundle can be decomposed. The tool
// cores (`recall.js`, `search.js`) and the compiler helpers they need
// (`estimateEntryTokens`, `sanitize`, `projectToolResultText`,
// `isCheckpointSource`) are vendored from upstream, adapted to the current
// session API: the removed `session.events` array is replaced by the public
// `session.eventAt(seq)` accessor and the contiguous `session.log` (see the
// `sessionEventAt`/`sessionLog` helpers below). The upstream `tool-recall` row
// is disabled in the web profile patch; this plugin is the sole source of
// `recall` / `search`.
//
// Two complementary entry points over the append-only event log:
//   - `recall` — restore the exact original content of earlier events by a
//     typed reference: `type: "seq"` for `(seq N)` / `(seqs A-B)` markers,
//     `type: "result"` for the `result N` pointer on a tool-call one-liner,
//     `type: "checkpoint"` for a `[checkpoint N]` elision line.
//   - `search` — keyword/regex search over the log. Returns an index: one
//     `[seq N: <label>] - K match(es)` line per matching event, freshest
//     matches first, with no output limits. The agent can then call `recall`
//     with any `(seq N)` pointer to restore that hit in full.
//   - `/recall` — the same search as a human-facing slash command; its result
//     is appended to the session as a user message (spilled to a file artifact
//     when the index is large, per the "full inline or file artifact" rule).
//
// Neither call does a model round-trip and neither paraphrases: the log is
// append-only, so the output is always the original content. No tool output is
// ever truncated: recall returns every requested seq in full, and search
// returns every matching event as one index line.
//
// ── schema format: RAW JSON Schema, NOT the dsh-tools DSL ───────────────────
// This plugin registers its `recall`/`search` tools via `ctx.tools.register()`
// directly (NOT `defineTool`). `register()` takes `parameters` and
// `output.schema` as ready raw JSON Schema and validates `output.schema`
// through `assertSupportedJsonSchema`/`checkSchemaNode`
// (dsh-tools/lib/index.js), which accepts a top-level `required` array but
// REJECTS per-property `required: true` on non-object nodes (`required` is
// only allowed on `type:"object"`). So the correct shape is
// `parameters: { type:"object", properties:{...}, required:[...] }` and
// `output.schema: { type:"object", additionalProperties:false, properties:{...},
// required:[...] }`. The DSL shape (per-property `required: true`, no wrapper)
// is only for `defineTool`'s spec compiler — using it with raw `register()`
// throws `JsonSchemaError` at plugin apply, which fails the whole
// `cordis:include` insert list.
//
// Bump the `?v=` in the referencing row of cordis.patch.yml after editing.
//
// ── system-prompt hint ───────────────────────────────────────────────────────
// Besides registering the tools, this plugin injects a short `recall-hint`
// section into the assembled system prompt (via the `system-prompt/assemble`
// waterfall). It tells the model
// that content elided/truncated by compaction (tool calls, results, skills,
// checkpoints) is restorable in full through `recall`/`search`, so the model
// reaches for those tools instead of guessing. The hint lives in the prompt
// (re-assembled every turn), not in the session log, so micro-compaction never
// folds it. Requires injecting `["systemPrompt"]` in addition to `["tools"]`.

const name = "dsh-tool-trajectory-recall";
const inject = ["tools", "systemPrompt", "commands"];

// ── minimal HarnessError (vendored shape from @deepseek-ai/dsh-llm) ────────
class HarnessError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

// ── vendored compiler subset ────────────────────────────────────────────────

const TOKEN_RE = /[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]|\s+/g;
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Split text into fixed-density tokens (VCC `_tokenize`). */
function tokenize(text) {
  return text.match(TOKEN_RE) ?? [];
}

/** Count the non-whitespace tokens of a text under {@link tokenize}. */
function countTokens(text) {
  let count = 0;
  for (const token of tokenize(text)) if (token.trim().length > 0) count += 1;
  return count;
}

/** Size one emitted entry the way every budget in this module is enforced. */
function estimateEntryTokens(text) {
  return Math.max(countTokens(text), Math.ceil(text.length / 4));
}

/** Strip carriage returns, ANSI escapes, and control bytes. */
function sanitize(text) {
  if (typeof text !== "string") return "";
  let out = text;
  if (out.includes("\r")) out = out.replaceAll("\r", "");
  if (out.includes("\x1b")) out = out.replace(ANSI_RE, "");
  return out.replace(CTRL_RE, "");
}

/** Project nested tool-result blocks into one plain-text string. */
function projectToolResultText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const text = sanitize(block.text ?? "");
      if (text.length > 0) parts.push(text);
    } else if (block.type === "image") parts.push("[image]");
    else if (block.type === "document") parts.push("[document]");
    else parts.push(`[${String(block.type)}]`);
  }
  return parts.join("\n");
}

/** Whether a message source identifies a landed compaction checkpoint node. */
function isCheckpointSource(source) {
  return source !== undefined && source.kind === "plugin" && source.plugin === "compact";
}

// ── session event access (current session API) ────────────────────────────────
// The session object no longer exposes the removed `session.events` array.
// Events are read through the public `eventAt(seq)` accessor and the full
// contiguous log through `session.log` (`seq = log.length` contiguity
// contract). These helpers keep the vendored cores working against the current
// API while falling back gracefully on older session shapes.

/** The session's contiguous event log, or an empty array when unavailable. */
function sessionLog(session) {
  return session.log ?? [];
}

/** Read one event by seq from the current session API (eventAt, else log). */
function sessionEventAt(session, seq) {
  if (typeof session.eventAt === "function") return session.eventAt(seq);
  return sessionLog(session)[seq];
}

// ── vendored recall core ────────────────────────────────────────────────────

/** Widest single range accepted from one selection, bounding expansion work. */
const MAX_RECALL_SPAN = 1000;

/** Parse one seq selection string into ordered inclusive ranges. */
function parseSeqSpec(input) {
  const selections = [];
  const errors = [];
  const raw = String(input ?? "").trim();
  if (raw.length === 0) return { selections, errors: ["missing seq selection"] };
  for (const part of raw.split(",")) {
    let token = part.trim();
    if (token.length === 0) continue;
    token = token.replace(/^\((.*)\)$/u, "$1").trim();
    const match = /^(?:seqs?\s+)?(\d+)(?:\s*-\s*(\d+))?$/iu.exec(token);
    if (match === null) {
      errors.push(`invalid seq selection "${part}"`);
      continue;
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (end < start) {
      errors.push(`invalid seq range "${part}" (end before start)`);
      continue;
    }
    if (end - start + 1 > MAX_RECALL_SPAN) {
      errors.push(`seq range "${part}" is wider than the ${MAX_RECALL_SPAN}-seq limit`);
      continue;
    }
    selections.push({ start, end });
  }
  return { selections, errors };
}

/** Project one derived message into plain text, keeping everything. */
function projectMessageText(message) {
  const parts = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        if (block.text !== undefined && block.text.length > 0) parts.push(sanitize(block.text));
        break;
      case "reasoning":
        if (block.text !== undefined && block.text.length > 0) parts.push(`[reasoning]\n${sanitize(block.text)}`);
        break;
      case "tool-call":
        parts.push(`[tool-call ${block.name ?? "unknown"}]\n${sanitize(block.arguments ?? "")}`);
        break;
      case "tool-result":
        parts.push(`[tool-result]\n${projectToolResultText(block.content ?? [])}`);
        break;
      case "image":
        parts.push("[image]");
        break;
      case "document":
        parts.push("[document]");
        break;
      default:
        parts.push(`[${String(block.type)}]`);
    }
  }
  return parts.join("\n");
}

/** Expand ordered selections into a deduplicated ordered seq list. */
function expandSelections(selections) {
  const seqs = [];
  const seen = new Set();
  for (const { start, end } of selections) {
    for (let seq = start; seq <= end; seq += 1) {
      if (seen.has(seq)) continue;
      seen.add(seq);
      seqs.push(seq);
    }
  }
  return seqs;
}

/** Collect the durable seqs of every landed compaction checkpoint node. */
function findCheckpointSeqs(session) {
  const seqs = [];
  for (const event of sessionLog(session)) {
    if (event.type === "user/message" && isCheckpointSource(event.data?.source)) seqs.push(event.seq);
  }
  return seqs;
}

/** Resolve one typed recall reference into inclusive seq ranges. */
function resolveRecallReference(session, type, id) {
  const raw = String(id ?? "").trim();
  if (type === "seq") return parseSeqSpec(raw);
  if (type === "result") {
    const token = raw.replace(/^\((.*)\)$/u, "$1").trim().replace(/^result\s+/iu, "");
    const match = /^(\d+)$/u.exec(token);
    if (match === null) return { selections: [], errors: [`invalid result reference "${id}" (expected a seq like "3" or "result 3")`] };
    const seq = Number(match[1]);
    const event = sessionEventAt(session, seq);
    if (event === undefined || event.seq !== seq) return { selections: [], errors: [`result seq ${seq} not found in this session`] };
    if (event.type !== "tool/result") return { selections: [], errors: [`seq ${seq} is not a tool result (it is ${event.type})`] };
    return { selections: [{ start: seq, end: seq }], errors: [] };
  }
  if (type === "checkpoint") {
    const token = raw.replace(/^\((.*)\)$/u, "$1").trim();
    const bySeq = /^seqs?\s+(\d+)$/iu.exec(token);
    if (bySeq !== null) {
      const seq = Number(bySeq[1]);
      const event = sessionEventAt(session, seq);
      if (event === undefined || event.seq !== seq) return { selections: [], errors: [`checkpoint seq ${seq} not found in this session`] };
      if (!isCheckpointSource(event.data?.source)) return { selections: [], errors: [`seq ${seq} is not a checkpoint node`] };
      return { selections: [{ start: seq, end: seq }], errors: [] };
    }
    const ordinal = token.replace(/^checkpoint\s+/iu, "");
    const match = /^(\d+)$/u.exec(ordinal);
    if (match === null) return { selections: [], errors: [`invalid checkpoint reference "${id}" (expected an ordinal like "1" or "checkpoint 1", or a "seq N" pointer)`] };
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1) return { selections: [], errors: [`invalid checkpoint ordinal "${id}"`] };
    const checkpointSeqs = findCheckpointSeqs(session);
    const seq = checkpointSeqs[index - 1];
    if (seq === undefined) return { selections: [], errors: [`checkpoint ${index} not found (this session has ${checkpointSeqs.length} checkpoint(s))`] };
    return { selections: [{ start: seq, end: seq }], errors: [] };
  }
  return { selections: [], errors: [`invalid recall type "${String(type)}" (expected "seq", "result", or "checkpoint")`] };
}

/** Recall the full original content of the requested seqs from one session. */
function recallSession(session, selections, config) {
  const requested = expandSelections(selections);
  const entries = [];
  const seqs = [];
  let missing = 0;
  for (let index = 0; index < requested.length; index += 1) {
    const seq = requested[index];
    const event = sessionEventAt(session, seq);
    if (event === undefined || event.seq !== seq) {
      missing += 1;
      entries.push({ seq, text: `[seq ${seq}: not found in this session]` });
      continue;
    }
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? `[seq ${seq}: ${message.role}]\n${projectMessageText(message)}`
      : `[seq ${seq}: ${event.type}]\n${JSON.stringify(event.data)}`;
    entries.push({ seq, text: body, truncated: false });
    seqs.push(seq);
  }
  return {
    text: entries.map((entry) => entry.text).join("\n\n"),
    entries,
    seqs,
    recalled: seqs.length,
    missing,
    skipped: 0,
    truncated: false,
    tokens: entries.reduce((total, entry) => total + estimateEntryTokens(entry.text), 0)
  };
}

// ── vendored search core ────────────────────────────────────────────────────
/** A search pattern that cannot be compiled into a regular expression. */
class InvalidSearchPatternError extends Error {
  constructor(source, reason) {
    super(`invalid search pattern ${JSON.stringify(String(source))}: ${reason}`);
    this.source = String(source);
  }
}

/** Compile one search pattern: case-insensitive, Unicode-aware regex. */
function compileSearchPattern(source) {
  const trimmed = String(source ?? "").trim();
  if (trimmed.length === 0) throw new InvalidSearchPatternError(source, "pattern is empty");
  try {
    return new RegExp(trimmed, "iu");
  } catch (error) {
    throw new InvalidSearchPatternError(source, error instanceof Error ? error.message : String(error));
  }
}

/** One index label for a matching event: tool name for tool rows, role otherwise. */
function searchEventLabel(session, events, seq, event, message) {
  const blocks = message !== null && Array.isArray(message.content) ? message.content : [];
  const toolCallBlock = blocks.find((block) => block.type === "tool-call");
  if (event.type === "tool/call" || toolCallBlock !== undefined) {
    const name = toolCallBlock !== undefined ? toolCallBlock.name : event.data?.name;
    return name !== undefined && name !== "" ? String(name) : "tool-call";
  }
  const toolResultBlock = blocks.find((block) => block.type === "tool-result");
  if (event.type === "tool/result" || toolResultBlock !== undefined) {
    let callId = toolResultBlock !== undefined && toolResultBlock.toolCallId !== undefined
      ? toolResultBlock.toolCallId
      : event.data?.message?.source?.callId ?? event.data?.callId;
    if (callId !== undefined && callId !== "") {
      for (let earlier = 0; earlier < seq; earlier += 1) {
        const earlierEvent = events[earlier];
        if (earlierEvent === undefined || earlierEvent.seq !== earlier) continue;
        const earlierMessage = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(earlierEvent) : null;
        if (earlierMessage === null || !Array.isArray(earlierMessage.content)) continue;
        const matching = earlierMessage.content.find((block) => block.type === "tool-call" && (block.toolCallId ?? block.id) === callId);
        if (matching !== undefined) return matching.name !== undefined && matching.name !== "" ? String(matching.name) : "tool-call";
      }
    }
    return "tool-result";
  }
  if (message !== null && message.role !== undefined && message.role !== "") return String(message.role);
  return String(event.type);
}

/** Search one session's log for matching events, freshest first, as an index. */
function searchSession(session, patternSource, config) {
  const pattern = compileSearchPattern(patternSource);
  const matchAllPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  const events = sessionLog(session);
  const hits = [];
  let totalMatches = 0;
  for (let seq = events.length - 1; seq >= 0; seq -= 1) {
    const event = events[seq];
    if (event === undefined || event.seq !== seq) continue;
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? projectMessageText(message)
      : `[${event.type}]\n${JSON.stringify(event.data ?? null)}`;
    let count = 0;
    for (const match of body.matchAll(matchAllPattern)) count += 1;
    if (count === 0) continue;
    totalMatches += 1;
    const label = searchEventLabel(session, events, seq, event, message);
    hits.push({ seq, kind: label, text: `[seq ${seq}: ${label}] - ${count} match${count === 1 ? "" : "es"}` });
  }
  const lines = [
    `[search "${pattern.source}": ${totalMatches} matching event(s)]`,
    ...hits.map((hit) => hit.text)
  ];
  if (hits.length > 0) lines.push("[use recall with a (seq N) pointer to restore any hit's full original content]");
  const text = lines.join("\n\n");
  return {
    pattern: pattern.source,
    totalMatches,
    hits,
    omitted: 0,
    truncated: false,
    tokens: hits.reduce((total, hit) => total + estimateEntryTokens(hit.text), 0),
    text
  };
}

// ── tool definitions (dependency-free) ──────────────────────────────────────

const RECALL_DESCRIPTION = "Restore the exact original content of earlier events in THIS conversation by a typed reference. type=\"seq\" with a seq selection id (\"3-7,15\", \"seq 12\", \"seqs 3-7\" — the checkpoint marker forms) restores those events; type=\"result\" with the \"result N\" pointer from a tool-call one-liner (\"result 3\" or \"3\") restores that tool result; type=\"checkpoint\" with an ordinal (\"1\" = oldest, as in a \"[checkpoint N]\" elision line) or a \"seq N\" pointer restores that full checkpoint. The durable log is append-only, so recalled content is always the original tokens. To find events by keyword or regex instead, use the search tool.";

const SEARCH_DESCRIPTION = "Search THIS conversation's durable event log by keyword or regular expression (case-insensitive, Unicode-aware). Every event ever recorded is searchable, including content elided or truncated by compaction checkpoints — the log is append-only and untouched. Returns an index: one `[seq N: <label>] - K match(es)` line per matching event, freshest matches first, with no output limits. Then call recall with a (seq N) pointer to restore any hit's full exact original content. Escape regex special characters(e.g. use \\\\( for a literal parenthesis).";

const RECALL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      recalled: { type: "integer" },
      missing: { type: "integer" },
      skipped: { type: "integer" },
      truncated: { type: "boolean" },
      tokens: { type: "integer" }
    },
    required: ["text", "recalled", "missing", "skipped", "truncated", "tokens"]
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

const SEARCH_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      pattern: { type: "string" },
      totalMatches: { type: "integer" },
      omitted: { type: "integer" },
      truncated: { type: "boolean" },
      tokens: { type: "integer" }
    },
    required: ["text", "pattern", "totalMatches", "omitted", "truncated", "tokens"]
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

/** Resolve the tool plugin configuration: no limits remain; accept any config silently. */
function resolveConfig(config = {}) {
  return {};
}

/** Shared execution of one typed recall request against the calling agent. */
function executeRecall(exec, type, id, resolved) {
  const agent = exec.agent;
  if (agent === undefined) throw new HarnessError("recall requires a calling agent with a session", "RECALL_AGENT_REQUIRED");
  const { selections, errors } = resolveRecallReference(agent.session, type, id);
  if (errors.length > 0) throw new HarnessError(`invalid ${type} recall: ${errors.join("; ")}`, "RECALL_INVALID_SELECTION");
  const recalled = recallSession(agent.session, selections, resolved);
  return {
    text: recalled.text,
    recalled: recalled.recalled,
    missing: recalled.missing,
    skipped: recalled.skipped,
    truncated: recalled.truncated,
    tokens: recalled.tokens
  };
}

/** Build the typed `recall` tool definition against one resolved config. */
function defineRecallTool(resolved) {
  return {
    name: "recall",
    description: RECALL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["seq", "result", "checkpoint"],
          description: 'Reference type: "seq" for events by sequence number, "result" for a tool result by its `result N` pointer, "checkpoint" for a whole checkpoint by ordinal or seq.'
        },
        id: {
          type: "string",
          description: 'Type-dependent reference: "3-7,15" / "seq 12" for seq; "result 3" or "3" for result; "1" / "checkpoint 1" or "seq 12345" for checkpoint.'
        }
      },
      required: ["type", "id"]
    },
    output: RECALL_OUTPUT,
    execute: (args, exec) => executeRecall(exec, args.type, args.id, resolved),
    presentCall: (args) => ({
      card: "generic",
      title: "Recall events",
      kind: "read",
      rawInput: `${args.type} ${args.id}`
    })
  };
}

/** Build the `search` (grep) tool definition against one resolved config. */
function defineSearchTool(resolved) {
  return {
    name: "search",
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Keyword or regular expression to search for (case-insensitive). Escape regex special characters."
        }
      },
      required: ["pattern"]
    },
    output: SEARCH_OUTPUT,
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new HarnessError("search requires a calling agent with a session", "RECALL_AGENT_REQUIRED");
      let result;
      try {
        result = searchSession(agent.session, args.pattern, resolved);
      } catch (error) {
        if (error instanceof InvalidSearchPatternError) throw new HarnessError(error.message, "SEARCH_INVALID_PATTERN", { cause: error });
        throw error;
      }
      return {
        text: result.text,
        pattern: result.pattern,
        totalMatches: result.totalMatches,
        omitted: result.omitted,
        truncated: result.truncated,
        tokens: result.tokens
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Search history",
      kind: "read",
      rawInput: args.pattern
    })
  };
}

/**
 * Register the recall tools (`recall` restore + `search` grep).
 * @param ctx - context carrying the tools service.
 * @param config - accepted silently and ignored (no limits remain).
 * @returns the installed registrations' combined disposer.
 */
/** Text of the system-prompt hint about restoring compacted content. */
const RECALL_HINT_TEXT =
  "Folded `seq`/`result`/`checkpoint` content may be restored in full using tools `recall` by id or `search` by keyword — `search` returns an untruncated (seq N) index; don't guess.";

/** Execute one grep-based `/recall` request against the calling agent's session. */
async function executeRecallCommand(invocation) {
  const pattern = String(invocation.rawInput ?? "").trim();
  if (pattern.length === 0) return { kind: "error", text: "Usage: /recall <keyword|regex>" };
  let result;
  try {
    result = searchSession(invocation.agent.session, pattern, {});
  } catch (error) {
    if (error instanceof InvalidSearchPatternError) return { kind: "error", text: error.message };
    throw error;
  }
  if (result.totalMatches === 0) return { kind: "error", text: `No matching events for "${pattern}".` };
  const opts = { surfaceOp: "append", sourceEventSeqs: result.hits.map((hit) => hit.seq) };
  let text = result.text;
  if (estimateEntryTokens(result.text) > 1000) {
    try {
      const store = invocation.agent.ctx?.get("spillStore");
      const sessionId = invocation.agent.session?.header?.id;
      if (store !== undefined && store !== null && sessionId !== undefined && sessionId !== null) {
        const ref = await store.saveText({
          owner: { sessionId },
          source: { kind: "tool", toolName: "command-recall", callId: String(invocation.commandId ?? ""), label: "result" },
          suggestedName: "recall-index.txt",
          content: result.text
        });
        text = `(Full formatted result stored at: ${ref.locator})`;
      }
    } catch (error) {
      // Spill unavailable: keep the full index text inline (never lose data).
      text = result.text;
    }
  }
  try {
    await invocation.agent.runMaintenance(() => {
      return invocation.agent.session.append("user/message", {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "recall", form: "recall" }
      }, opts);
    });
  } catch (error) {
    return { kind: "error", text: error instanceof Error ? error.message : String(error) };
  }
  return { kind: "success", text: `Found ${result.totalMatches} matching event(s) (~${result.tokens} tokens).` };
}

function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineRecallTool(resolved)),
      ctx.tools.register(defineSearchTool(resolved)),
      ctx.commands.register({
        name: "recall",
        description: "Search earlier conversation history by keyword or regex",
        handler: (invocation) => executeRecallCommand(invocation)
      })
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
  // Inject a short hint into the assembled system prompt so the model knows
  // compacted content is restorable via recall/search (see header comment).
  ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
    if (Array.isArray(assembly.sections)) {
      assembly.sections.push({ name: "recall-hint", text: RECALL_HINT_TEXT });
    }
    return next();
  });
}
export { apply, inject, name };
