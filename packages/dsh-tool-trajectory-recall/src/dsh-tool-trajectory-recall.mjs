// dsh-tool-trajectory-recall.mjs
// Cordis plugin: model-facing same-session recall tools (`recall` restore +
// `search` grep) over the durable session log.
//
// This is the recall/search half of the upstream compaction plugin, split out
// into its own dependency-free plugin so the bundle can be decomposed. The tool
// cores (`recall.js`, `search.js`) and the compiler helpers they need
// (`estimateEntryTokens`, `sanitize`, `truncateTokens`, `projectToolResultText`,
// `isCheckpointSource`) are vendored verbatim because profile-local plugin
// files are loaded dependency-free. The upstream `tool-recall` row is disabled
// in the web profile patch; this plugin is the sole source of `recall` /
// `search`.
//
// Two complementary entry points over the append-only event log:
//   - `recall` — restore the exact original content of earlier events by a
//     typed reference: `type: "seq"` for `(seq N)` / `(seqs A-B)` markers,
//     `type: "result"` for the `result N` pointer on a tool-call one-liner,
//     `type: "checkpoint"` for a `[checkpoint N]` elision line.
//   - `search` — keyword/regex search over the log. Returns the matching
//     events with their `(seq N)` pointers, so the agent can then call
//     `recall` to restore any hit in full.
//
// Neither call does a model round-trip and neither paraphrases: the log is
// append-only, so the output is always the original content.
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
const inject = ["tools", "systemPrompt"];

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

function completeCodePointAtEnd(text) {
  return isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text;
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

/** Truncate text to a non-whitespace-token budget, preserving original tokens. */
function truncateTokens(text, limit, ref) {
  const tokens = tokenize(text);
  let count = 0;
  let cut = tokens.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.trim().length === 0) continue;
    count += 1;
    if (count > limit) {
      cut = index;
      break;
    }
  }
  let out = cut >= tokens.length ? text : tokens.slice(0, cut).join("");
  let truncated = cut < tokens.length;
  const maxChars = Math.max(32, limit * 4);
  if (out.length > maxChars) {
    out = completeCodePointAtEnd(out.slice(0, maxChars));
    truncated = true;
  } else if (truncated) {
    out = completeCodePointAtEnd(out);
  }
  if (!truncated) return { text, truncated: false };
  out = out.replace(/\s+$/u, "");
  const note = ref === undefined ? "...(truncated)" : `...(truncated from ${ref})`;
  return { text: out + note, truncated: true };
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

// ── vendored recall core ────────────────────────────────────────────────────

/** Default total budget for one recall operation, in density-aware tokens. */
const DEFAULT_MAX_RECALL_TOKENS = 16000;
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
  for (const event of session.events) {
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
    const event = session.events[seq];
    if (event === undefined || event.seq !== seq) return { selections: [], errors: [`result seq ${seq} not found in this session`] };
    if (event.type !== "tool/result") return { selections: [], errors: [`seq ${seq} is not a tool result (it is ${event.type})`] };
    return { selections: [{ start: seq, end: seq }], errors: [] };
  }
  if (type === "checkpoint") {
    const token = raw.replace(/^\((.*)\)$/u, "$1").trim();
    const bySeq = /^seqs?\s+(\d+)$/iu.exec(token);
    if (bySeq !== null) {
      const seq = Number(bySeq[1]);
      const event = session.events[seq];
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
  const maxRecallTokens = config.maxRecallTokens;
  const requested = expandSelections(selections);
  const entries = [];
  const seqs = [];
  let budget = maxRecallTokens;
  let truncated = false;
  let missing = 0;
  let skipped = 0;
  for (let index = 0; index < requested.length; index += 1) {
    const seq = requested[index];
    if (budget <= 0) {
      skipped = requested.length - index;
      truncated = true;
      break;
    }
    const event = session.events[seq];
    if (event === undefined || event.seq !== seq) {
      missing += 1;
      entries.push({ seq, text: `[seq ${seq}: not found in this session]` });
      continue;
    }
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? `[seq ${seq}: ${message.role}]\n${projectMessageText(message)}`
      : `[seq ${seq}: ${event.type}]\n${JSON.stringify(event.data).slice(0, maxRecallTokens * 4)}`;
    const kept = truncateTokens(body, budget, "recall budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) truncated = true;
    entries.push({ seq, text: kept.text, truncated: kept.truncated });
    seqs.push(seq);
  }
  if (skipped > 0) {
    entries.push({ seq: requested[requested.length - skipped], text: `[recall budget exhausted: ${skipped} further requested seq(s) not included]` });
  }
  return {
    text: entries.map((entry) => entry.text).join("\n\n"),
    entries,
    seqs,
    recalled: seqs.length,
    missing,
    skipped,
    truncated,
    tokens: entries.reduce((total, entry) => total + estimateEntryTokens(entry.text), 0)
  };
}

// ── vendored search core ────────────────────────────────────────────────────

/** Default cap on the number of matching events shown in one result. */
const DEFAULT_MAX_SEARCH_HITS = 50;
/** Default cap on shown matching lines per hit event. */
const MAX_LINES_PER_HIT = 10;

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

/** One search hit: the durable seq, its kind, and the rendered matched lines. */
function searchSession(session, patternSource, config) {
  const pattern = compileSearchPattern(patternSource);
  const maxHits = config.maxSearchHits;
  const maxTokens = config.maxRecallTokens;
  const events = session.events;
  const hits = [];
  let totalMatches = 0;
  let budget = maxTokens;
  let truncated = false;
  for (let seq = 0; seq < events.length; seq += 1) {
    const event = events[seq];
    if (event === undefined || event.seq !== seq) continue;
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? projectMessageText(message)
      : `[${event.type}]\n${JSON.stringify(event.data ?? null)}`;
    const lines = body.split("\n");
    const matched = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) matched.push({ line: index + 1, text: sanitize(lines[index]) });
    }
    if (matched.length === 0) continue;
    totalMatches += 1;
    if (hits.length >= maxHits || budget <= 0) {
      truncated = true;
      continue;
    }
    const header = `[seq ${seq}: ${message !== null ? message.role : event.type}]`;
    const shown = matched.slice(0, MAX_LINES_PER_HIT);
    const more = matched.length - shown.length;
    const block = [
      header,
      ...shown.map((match) => `  ${match.line}: ${match.text}`),
      ...(more > 0 ? [`  ...(${more} more matching lines in this event)`] : [])
    ].join("\n");
    const kept = truncateTokens(block, budget, "search budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) truncated = true;
    hits.push({ seq, kind: message !== null ? message.role : event.type, text: kept.text });
  }
  const omitted = totalMatches - hits.length;
  const lines = [
    `[search "${pattern.source}": ${totalMatches} matching event(s)]`,
    ...hits.map((hit) => hit.text),
    ...(omitted > 0 ? [`[${omitted} more matching event(s) omitted — narrow the pattern or use recall]`] : []),
    ...(truncated ? ["[search budget exhausted; some hits were cut]"] : [])
  ];
  if (hits.length > 0) lines.push("[use recall with a (seq N) pointer to restore any hit's full original content]");
  const text = lines.join("\n\n");
  return {
    pattern: pattern.source,
    totalMatches,
    hits,
    omitted,
    truncated,
    tokens: hits.reduce((total, hit) => total + estimateEntryTokens(hit.text), 0),
    text
  };
}

// ── tool definitions (dependency-free) ──────────────────────────────────────

const RECALL_DESCRIPTION = "Restore the exact original content of earlier events in THIS conversation by a typed reference. type=\"seq\" with a seq selection id (\"3-7,15\", \"seq 12\", \"seqs 3-7\" — the checkpoint marker forms) restores those events; type=\"result\" with the \"result N\" pointer from a tool-call one-liner (\"result 3\" or \"3\") restores that tool result; type=\"checkpoint\" with an ordinal (\"1\" = oldest, as in a \"[checkpoint N]\" elision line) or a \"seq N\" pointer restores that full checkpoint. The durable log is append-only, so recalled content is always the original tokens. To find events by keyword or regex instead, use the search tool.";

const SEARCH_DESCRIPTION = "Search THIS conversation's durable event log by keyword or regular expression (case-insensitive, Unicode-aware). Every event ever recorded is searchable, including content elided or truncated by compaction checkpoints — the log is append-only and untouched. Returns the matching events with their (seq N) seq numbers and the matching lines. Then call recall with a (seq N) pointer to restore any hit's full exact original content. Escape regex special characters (e.g. use \\\\( for a literal parenthesis).";

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

/** Validate and default the tool plugin configuration. */
function resolveConfig(config = {}) {
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  const maxSearchHits = config.maxSearchHits ?? DEFAULT_MAX_SEARCH_HITS;
  if (typeof maxRecallTokens !== "number" || !Number.isInteger(maxRecallTokens) || maxRecallTokens <= 0) throw new Error("ToolRecallConfig: maxRecallTokens must be a positive integer");
  if (typeof maxSearchHits !== "number" || !Number.isInteger(maxSearchHits) || maxSearchHits <= 0) throw new Error("ToolRecallConfig: maxSearchHits must be a positive integer");
  return { maxRecallTokens, maxSearchHits };
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
 * @param config - `{ maxRecallTokens?, maxSearchHits? }`.
 * @returns the installed registrations' combined disposer.
 */
/** Text of the system-prompt hint about restoring compacted content. */
const RECALL_HINT_TEXT =
  "Folded `seq`/`result`/`checkpoint` content may be restored using tools `recall` by id or `search` by keyword — don't guess.";

function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineRecallTool(resolved)),
      ctx.tools.register(defineSearchTool(resolved))
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
