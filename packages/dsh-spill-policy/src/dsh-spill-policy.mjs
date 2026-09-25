/**
 * dsh-spill-policy - replacement spill policy (task: spill-and-recall)
 *
 * Divergence from base @deepseek-ai/dsh-spill-policy preview policy:
 *
 *   - Base: byte cap (maxInlineBytes=50000 in this deployment); keeps a bounded
 *     head/tail preview plus a spill notice for oversized plain-text results.
 *
 *   - This plugin: same shape but a much tighter byte cap (maxInlineBytes,
 *     default 4096). The model first judges volume from a short head/tail
 *     preview plus the notice (total byte/line counts), then reads the full
 *     artifact back via read when it actually needs the data.
 *
 *   - Structured results are classified before saving but the artifact is saved
 *     VERBATIM, never reformatted: the model can still inspect the original
 *     formatting(e.g.whether a downloaded JSON was minified).Classification only drives
 *       * the artifact extension(.json/.jsonl/.yaml/.csv/.tsv/.xml/.html/.txt fallback),and
 *       * a first-level structural summary folded into the stats line of the
 *         replacement ("[JSONL · N bytes · M lines · N records · first-record
 *         keys: ...]" / "[JSON object · ... · keys: ...]" / "[CSV · ... · R rows
 *         · C columns · header ...]" / "[XML · ... · root <...>]" / "[HTML · ...
 *         · title: ... · lang: ...]" / "[YAML ...]"),
 *         so volume can be judged without reading anything.
 *     MCP tools wrap their result in a content-block envelope
 *     ([{"type":"text","text":"..."}]); such envelopes are unwrapped before
 *     classification so browser/jira/slack dumps classify by their payload, not
 *     as "JSON array of one text block". An envelope whose payload is plain text
 *     falls back to txt. HTML summaries carry only title/lang(present parts
 *     only, no null placeholders; both absent -> bare [HTML]).
 *     Detection order: single JSON value -> JSONL -> HTML -> XML -> CSV/TSV ->
 *     YAML. Markdown and other prose are deliberately left as plain text.
 *     Parsing failure falls back to plain text("looks structured but does not
 *     parse -> treat as txt"): .txt extension,no summary.
 *
 *   - excludeTools (default ["read", "skill"]): model-facing results of these
 *     tools never spill and stay inline in full. read must stay excluded to avoid
 *     a read -> spill -> read again loop; skill results are instructions the model
 *     needs verbatim.
 *
 *   - The oversized preview is a MINIMAL sample, not a budget-filling head/tail
 *     slice: the first `headLines` non-empty lines and the last `tailLines`
 *     non-empty line(s), each capped at `lineCap` bytes. A per-line ellipsis
 *     plus "[truncated N bytes]" tag marks a capped line; a "[truncated N
 *     lines]" marker separates head from tail when lines were skipped. The two
 *     notice lines ("[Saved at <locator>]" and a stats line) sit at the top and
 *     double as the head/tail separator. lineCap is derived from the cap minus
 *     a worst-case overhead so the replacement never exceeds maxInlineBytes by
 *     construction (the best-effort guard below stays as a safety net).
 *
 * Oversized iff utf8ByteLength(text) > maxInlineBytes.
 *
 * Structure mirrors base exactly: registers NO service and owns NO storage -
 * storage is ctx.spillStore (@deepseek-ai/dsh-spill-local); the policy only
 * decides WHEN to spill and composes the replacement. Prepended listeners
 * delegate via next() so tool-owned projections run first.
 *
 * Arm 1 (tools/post-execute, prepended): bounds the model-facing result.
 *
 * Arm 2 (tools/ptc-dispatch-log, prepended): bounds the durable-log copy of
 * oversized sub-call results(the program value stays untouched).
 *
 * Best-effort contract identical to base semantics: no session owner,no
 * ctx.spillStore backend,or a save failure - log and return the original result;a
 * spill failure must NEVER turn a successful call into an isError or hide inline result.
 *
 * Dependency-free host plugin except js-yaml(lazy dynamic import;when absent,
 * YAML classification is skipped and such results are treated as plain text).
 */

export const name = "dsh-spill-policy";
/** Require the tool registry (its tools/post-execute waterfall is the extension point we transform). */
export const inject = ["tools"];

/** All-text content flattened to one UTF-8 string, or undefined if any block is non-text. */
function flattenPlainText(content) {
	let text = "";
	for (const block of content) {
		if (block.type !== "text") return void 0;
		text += block.text;
	}
	return text;
}

/** The owning session id, or undefined for a call with no agent (a direct/test call). */
function ownerSessionId(exec) {
	return exec.agent?.session.header.id;
}

/** Prefix of `text` whose UTF-8 size does not exceed `maxBytes`; never splits code points. */
function takeBytes(text, maxBytes) {
	let out = "";
	let bytes = 0;
	for (const ch of text) {
		const b = Buffer.byteLength(ch, "utf8");
		if (bytes + b > maxBytes) break;
		out += ch;
		bytes += b;
	}
	return { text: out };
}

/** Lazily loaded js-yaml module(default export), cached; undefined when unavailable. */
let yamlModulePromise;

function loadYaml() {
	yamlModulePromise ??= import("js-yaml").then((m)=>m.default??m).catch(()=>void 0);
	return yamlModulePromise;
}

/** Accept only genuinely useful YAML structures: arrays(len>=2 or containing objects) or mappings(>=2 keys or a nested value). */
function isUsefulYaml(value) {
	if (Array.isArray(value)) return value.length >= 2 || value.some((v)=>v!==null&&typeof v==="object");
	if (value===null||typeof value!=="object") return false;
	const keys=Object.keys(value);
	if (keys.length>=2) return true;
	if (keys.length===1) return value[keys[0]]!==null&&typeof value[keys[0]]==="object";
	return false;
}

/** Delimiter-separated table detection(CSV/TSV): >=2 non-empty lines with a consistent field count >=2 across up to 50 lines. */
function detectDelimited(text, delimiter) {
	const lines = text.split("\n").map((l)=>l.trim()).filter((l)=>l.length>0);
	if (lines.length < 2) return void 0;
	let count = null;
	for (const line of lines.slice(0, 50)) {
		const c = line.split(delimiter).length;
		if (count === null) count = c; else if (c !== count) return void 0;
	}
	if (!count || count < 2) return void 0;
	return { rows: lines.length, columns: count, header: lines[0] };
}

/** Root element name via a light regex(no full parser); undefined when absent. */
function detectXmlRoot(text) {
	const m = /<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>/.exec(text);
	return m ? m[1] : void 0;
}

/**
 * Content-block transport envelope detection(MCP tools serialize their result as
 * [{"type":"text","text":"..."}], sometimes a single block object). Returns the
 * concatenated inner text when EVERY block is a pure {type:"text",text:string},
 * otherwise undefined.
 */
function unwrapContentBlocks(value) {
	const blocks = Array.isArray(value) ? value : [value];
	if (blocks.length === 0) return void 0;
	let text = "";
	for (const block of blocks) {
		if (block === null || typeof block !== "object") return void 0;
		if (block.type !== "text" || typeof block.text !== "string") return void 0;
		text += block.text;
	}
	return text.length > 0 ? text : void 0;
}

/**
 * Classify `text` as structured:{kind:"json"|"jsonl"|"html"|"xml"|"csv"|"tsv"|"yaml",value} or undefined
 * when it is plain text(or looks structured but fails to parse -> txt).
 */
export async function tryParseStructured(text, depth = 0) {
	const trimmed = text.trim();
	if (!trimmed) return void 0;
	if ((trimmed[0]==="{"&&trimmed[trimmed.length-1]==="}")||(trimmed[0]==="["&&trimmed[trimmed.length-1]==="]")) {
		try {
			const value = JSON.parse(trimmed);
			if (depth < 3) {
				const inner = unwrapContentBlocks(value);
				if (inner !== void 0 && inner !== trimmed) {
					const nested = await tryParseStructured(inner, depth + 1);
					if (nested !== void 0) return nested;
					return void 0; // pure transport envelope whose payload is plain text -> txt
				}
			}
			return { kind:"json", value };
		} catch { /* fall through */ }
	}
	const lines = trimmed.split("\n");
	if (lines.length >= 2) {
		let ok = true;
		const records = [];
		for (const line of lines) {
			const l = line.trim();
			if (!l) continue;
			if (!((l[0]==="{"&&l[l.length-1]==="}")||(l[0]==="["&&l[l.length-1]==="]"))) { ok=false; break; }
			try { records.push(JSON.parse(l)); } catch { ok=false; break; }
		}
		if (ok && records.length > 0) return { kind:"jsonl", value:{ records } };
	}
	if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
		const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed);
		const langMatch = /<html[^>]*\blang=["']([^"']+)["']/i.exec(trimmed);
		return {
			kind: "html",
			value: {
				title: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 120) : "",
				lang: langMatch ? langMatch[1].toLowerCase() : ""
			}
		};
	}
	const root = detectXmlRoot(trimmed);
	if (root && trimmed.startsWith("<")) return { kind:"xml", value:{ root } };
	const csv = detectDelimited(trimmed, ",");
	if (csv) return { kind:"csv", value: csv };
	const tsv = detectDelimited(trimmed, "\t");
	if (tsv) return { kind:"tsv", value: tsv };
	try {
		const yml = await loadYaml();
		if (!yml) return void 0;
		const value = yml.load(trimmed);
		if (isUsefulYaml(value)) return { kind:"yaml", value };
	} catch { /* not yaml -> plain text */ }
	return void 0;
}

/** Short label for a classified kind("JSON array"/"JSON object"/"JSONL"/"CSV"/...; "txt" for plain text). */
export function kindLabel(kind, value) {
	if (kind === void 0) return "txt";
	if (kind === "json" || kind === "yaml") return Array.isArray(value) ? `${kind.toUpperCase()} array` : `${kind.toUpperCase()} object`;
	return kind.toUpperCase();
}

/**
 * First-level structural summary tail for a classified kind - the part after
 * "kind · bytes · lines" in the stats line (no leading kind label, no brackets,
 * no trailing newline). Empty string for plain text.
 */
export function summarizeStructured(kind, value) {
	switch (kind) {
	case "jsonl": {
			const records=value.records;
			const first=records.find((r)=>r!==null&&typeof r==="object");
			const keys=first?Object.keys(first).slice(0,8).join(", "):"";
			return `${records.length} records${keys?` \u00b7 first-record keys: ${keys}`:""}`;
	}
	case "csv":
	case "tsv":
			return `${value.rows} rows \u00b7 ${value.columns} columns${value.header?` \u00b7 header: ${value.header.slice(0,120)}`:""}`;
	case "xml":
			return `root <${value.root}>`;
	case "html": {
			const parts = [];
			if (value.title) parts.push(`title: ${value.title}`);
			if (value.lang) parts.push(`lang: ${value.lang}`);
			return parts.join(" \u00b7 ");
	}
	default:
			break;
	}
	if (Array.isArray(value)) {
			const first=value.find((v)=>v!==null&&typeof v==="object");
			const keys=first?Object.keys(first).slice(0,8).join(", "):"";
			return `${value.length} records${keys?` \u00b7 first-record keys: ${keys}`:""}`;
	}
	const keys=Object.keys(value).slice(0,12).join(", ");
	return `keys: ${keys}`;
}

/** Artifact extension for a classified kind; ".txt" for plain text. */
export function artifactExtension(kind){
	switch(kind){
	case "json":return ".json";
	case "jsonl":return ".jsonl";
	case "yaml":return ".yaml";
	case "csv":return ".csv";
	case "tsv":return ".tsv";
	case "xml":return ".xml";
	case "html":return ".html";
	default:return ".txt";
}}

/**
 * Compose the oversized replacement preview. Returns the replacement text or
 * undefined when the worst-case overhead alone already exceeds `cap` (the
 * caller then keeps the inline content).
 *
 * Layout (top to bottom): "[Saved at <locator>]" notice, a stats line, the
 * first `headLines` non-empty lines, a "[truncated N lines]" marker when lines
 * were skipped, then the last `tailLines` non-empty lines. Each sampled line is
 * capped at `lineCap` bytes; a capped line gains a "\u2026 [truncated N bytes]"
 * suffix. lineCap is derived so the result never exceeds `cap` by construction.
 */
export function composeReplacement({ cap, headLines, tailLines, content, structured, locator }) {
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = content.split("\n").length;
	const label = kindLabel(structured?.kind, structured?.value);
	const rest = structured ? summarizeStructured(structured.kind, structured.value) : "";
	const notice1 = `[Saved at ${locator}]`;
	const lineWord = lines === 1 ? "line" : "lines";
	const notice2 = `[${label} \u00b7 ${totalBytes} bytes \u00b7 ${lines} ${lineWord}${rest ? ` \u00b7 ${rest}` : ""}]`;

	const previewLineCount = headLines + tailLines;
	// Worst-case per-line cap suffix and middle marker (digit counts bounded by
	// the byte/line counts), plus the newlines between every element.
	const lineSuffixMax = Buffer.byteLength(`\u2026 [truncated ${"0".repeat(String(totalBytes).length)} bytes]`, "utf8");
	const markerMax = Buffer.byteLength(`[truncated ${"0".repeat(String(lines).length)} lines]`, "utf8");
	const overhead =
		Buffer.byteLength(notice1, "utf8") + Buffer.byteLength(notice2, "utf8") +
		(previewLineCount + 2) + previewLineCount * lineSuffixMax + markerMax;
	if (overhead > cap) return void 0;
	const lineCap = Math.floor((cap - overhead) / previewLineCount);

	const sampleLines = content.split("\n").filter((l) => l.trim().length > 0);
	const total = sampleLines.length;
	const head = lineCap > 0 ? sampleLines.slice(0, headLines) : [];
	const tail = lineCap > 0 ? sampleLines.slice(Math.max(headLines, total - tailLines)) : [];
	const skipped = Math.max(0, total - head.length - tail.length);

	const render = (line) => {
		const taken = takeBytes(line, lineCap);
		const cut = Buffer.byteLength(line, "utf8") - Buffer.byteLength(taken.text, "utf8");
		return cut > 0 ? `${taken.text}\u2026 [truncated ${cut} bytes]` : line;
	};

	const parts = [notice1, notice2];
	for (const l of head) parts.push(render(l));
	if (skipped > 0) parts.push(`[truncated ${skipped} lines]`);
	for (const l of tail) parts.push(render(l));
	return parts.join("\n");
}

export function apply(ctx, config) {
	const cap = Number.isInteger(config?.maxInlineBytes) ? config.maxInlineBytes : 4096;
	if (!Number.isInteger(cap) || cap < 0) throw new Error(`dsh-spill-policy: maxInlineBytes must be a non-negative integer (got ${cap})`);
	const headLines = Number.isInteger(config?.headLines) ? config.headLines : 2;
	const tailLines = Number.isInteger(config?.tailLines) ? config.tailLines : 1;
	if (!Number.isInteger(headLines) || headLines < 0 || !Number.isInteger(tailLines) || tailLines < 0 || headLines + tailLines < 1) {
		throw new Error(`dsh-spill-policy: headLines and tailLines must be non-negative integers with headLines + tailLines >= 1 (got headLines=${headLines}, tailLines=${tailLines})`);
	}
	const excludeTools = Array.isArray(config?.excludeTools) && config.excludeTools.length > 0 ? config.excludeTools : ["read", "skill"];

	async function spillReplacement(sessionId, toolName, callId, content) {
		if (sessionId === void 0) {
			ctx.logger.warn(`dsh-spill-policy: no session owner for ${toolName} ${callId}; keeping the inline content`);
			return undefined;
		}
		const store = ctx.get("spillStore");
		if (!store) {
			ctx.logger.warn("dsh-spill-policy: spill-store unavailable; keeping the inline content");
			return undefined;
		}
		let structured;
		try { structured = await tryParseStructured(content); } catch { structured = void 0; }
		let ref;
		try {
			ref = await store.saveText({
				owner: { sessionId },
				source: { kind: "tool", toolName, callId },
				suggestedName: `${toolName}${structured ? artifactExtension(structured.kind) : ".txt"}`,
				content
			});
		} catch (error) {
			ctx.logger.warn(`dsh-spill-policy: saveText failed for ${toolName}: ${String(error)}; keeping the inline content`);
			return undefined;
		}
		const replacedText = composeReplacement({
			cap, headLines, tailLines, content, structured, locator: ref.locator
		});
		if (replacedText === void 0) {
			ctx.logger.warn(`dsh-spill-policy: spill notice for ${toolName} exceeds maxInlineBytes; keeping the inline content`);
			return undefined;
		}
		if (Buffer.byteLength(replacedText, "utf8") > cap) {
			ctx.logger.warn(`dsh-spill-policy: spill notice for ${toolName} exceeds maxInlineBytes; keeping the inline content`);
			return undefined;
		}
		return replacedText;
	}

	ctx.on("tools/post-execute", async (exec, result, next) => {
		const decision = await next();
		if (
			decision.kind !== "accept" ||
			Object.hasOwn(decision, "value") ||
			exec.parent !== undefined ||
			excludeTools.includes(exec.name)
		) return decision;
		const text = flattenPlainText(decision.content ?? result.content);
		if (text === void 0) return decision;
		if (Buffer.byteLength(text, "utf8") <= cap) return decision;
		const replacedText = await spillReplacement(ownerSessionId(exec), exec.name, exec.callId, text);
		if (replacedText === void 0) return decision;
		return {
			kind: "accept",
			content: [{
				type: "text",
				text: replacedText
			}],
			...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}
		};
	}, { prepend: true });

ctx.on("tools/ptc-dispatch-log", async (dispatch , next) => {
	const content = await next();
	const text = flattenPlainText(content);
	if (text === void 0) return content;
	if (Buffer.byteLength(text, "utf8") <= cap) return content;
	const replacedText = await spillReplacement(ownerSessionId(dispatch.exec), dispatch.name, dispatch.subCallId, text);
	if (replacedText === void 0) return content;
	return [{
			type: "text",
			text: replacedText
}];
}, { prepend: true });
}
