// dsh-provider-websearch-lightpanda.mjs
// Cordis plugin: a WebRuntime (ctx.web) provider pair backed by the lightpanda
// MCP server — one WebSearchProvider and one WebFetchProvider, both with id
// "lightpanda".
//
// Call path: web_search/web_fetch → ctx.web → this provider → a programmatic
// `ctx.tools.execute` of dsh-mcp-adapter's `mcp` proxy tool → the mcporter
// bridge server "m" (mcporter-serve-claude) → the lightpanda MCP server "lp"
// (registered in the mcporter config). Routing through `mcp` reuses the
// adapter's lazy connection pool and its single lightpanda browser process —
// this plugin never spawns its own browser. The lightpanda server itself does
// the real work: search uses its EXA-backed `search` tool (EXA_API_KEY lives
// in the server's env in the mcporter config), fetch uses `goto` +
// `markdown` (full JS rendering and the shared cookie jar). The mcporter
// bridge namespaces tools as `<server>__<tool>`, so these are `m_lp__search`,
// `m_lp__goto`, `m_lp__markdown`.
//
// The seam itself (@deepseek-ai/dsh-web) is mounted once globally by dsh-base
// with `searchProvider: deepseek-official` — mounting it again here fails with
// "service has been registered". So this plugin instead re-points the live
// WebRuntime at "lightpanda" for both capabilities and restores the previous
// selection on dispose. It is mounted in the HOST composition
// (cordis.patch.yml), so registration and re-pointing happen exactly once at
// startup rather than per session.
// The model-facing web_search / web_fetch tools come from a preset-local row
// of @deepseek-ai/dsh-tool-web (scoped registrations shadow per agent, so the
// row does not collide with the Standard mode's own copy).
//
// Known lightpanda build limits (measured 2026-08-25): `extract`/`evaluate`
// die with ExecutionTerminated, and JS-proof-of-work anti-bot walls (Anubis,
// Startpage) never complete — both are detected here and surfaced as honest
// provider errors instead of silent garbage or retry loops.
//
// After editing this file bump the `?v=` in the referencing row of
// cordis.patch.yml, otherwise the loader may serve the cached module.
//
// ---------------------------------------------------------------------------
// Reference: lightpanda search output format, limits, and engine selection
// (verified against lightpanda-io/browser @ main, 2026-08-25).
//
// 1. Search tool schema — only `query` and `timeout`; there is NO result-count
//    or limit parameter. The 10-result cap is hard-coded per engine.
//    https://github.com/lightpanda-io/browser/blob/main/src/browser/tools.zig
//    (`.search => .{ ... }` tool_def, and `SearchParams = struct { query,
//    timeout }`).
//
// 2. Result markdown format — each result is rendered by `writeResultItem` as:
//        N. **title** — https://url
//           snippet
//    i.e. a numbered line with a **bold** title, an em-dash, a BARE url (no
//    markdown link syntax), then the snippet on the NEXT line indented by 3
//    spaces. This is why parseSearchSources matches a bare URL + **bold**
//    title and reads the following indented line as the snippet.
//    https://github.com/lightpanda-io/browser/blob/main/src/browser/tools.zig
//    (`writeResultItem`, `formatExaMarkdown`).
//
// 3. Engine selection & limits — `.auto` tries brave → tavily → exa (each only
//    when its API key env var is set), then falls back to scraping the
//    DuckDuckGo HTML endpoint. EXA is configured with `numResults = 10` and
//    `contents.highlights.numSentences = 3`; brave uses `count = 10`, tavily
//    `max_results = 10`. So EXA returns exactly 10 results by default.
//    https://github.com/lightpanda-io/browser/blob/main/src/browser/tools.zig
//    (`api_engines` table, `execSearch`, `searchEnvVar`).
//
// 4. EXA API response shape — `Result { title, url, highlights }`; snippet text
//    is only present when `contents.highlights` is requested (it is). The
//    client POSTs to `https://api.exa.ai/search` with `x-api-key`.
//    https://github.com/lightpanda-io/zenai/blob/main/src/search/exa/types.zig
//    https://github.com/lightpanda-io/zenai/blob/main/src/search/exa/Client.zig
//
// 5. MCP tool wiring — browser tools are exposed over MCP by src/mcp/tools.zig;
//    the search tool is a BrowserTool dispatched through `dispatchBrowserTool`.
//    https://github.com/lightpanda-io/browser/blob/main/src/mcp/tools.zig
//
// The seam-side source cap lives in @deepseek-ai/dsh-tool-web (`searchMaxResults`,
// default 8) and is mirrored here via `config.maxSources` so the plugin never
// keeps more sources than the model sees. Both are set to 10 in agent.cordis.yml.
// ---------------------------------------------------------------------------

const name = "dsh-provider-websearch-lightpanda";
const inject = ["web", "tools", "agents"];

/**
 * MCP server name as configured in the dsh-mcp-adapter `mcpServers` list.
 * This is the mcporter bridge (`mcporter-serve-claude`, server "m" in
 * the dsh-mcp-adapter mcpServers list), which exposes every mcporter server as one MCP server with
 * tools namespaced as `<server>__<tool>`. The lightpanda server is registered
 * in the mcporter config under the name "lp".
 */
const SERVER = "m";
/** lightpanda server name inside the mcporter config. */
const MCPORTER_SERVER = "lp";
/** Provider id registered with the seam and named in the seam config. */
const PROVIDER_ID = "lightpanda";
/** Cap on a fetched markdown body; the tool layer has its own render cap. */
const FETCH_MAX_CHARS = 100000;
/** lightpanda goto budget (ms); the MCP call itself is capped by the adapter. */
const GOTO_TIMEOUT_MS = 30000;

// --- anti-bot / captcha signatures -----------------------------------------
// DuckDuckGo HTML endpoint falls back to an image captcha for headless
// traffic; lightpanda's search tool returns that page verbatim when no search
// API key reaches the browser process.
const DDG_CAPTCHA = /select all squares containing a duck|anomaly\/images\/challenge/i;
// Anubis-style JS proof-of-work walls (Startpage and others) never finish in
// lightpanda's JS engine; the page text is stable enough to match.
const ANTI_BOT = /making sure you.?re not a bot|proof of work|verify you are human|checking your browser/i;

/** True when a lightpanda search result is the DDG captcha page, not results. */
function isCaptchaPage(text) {
	return DDG_CAPTCHA.test(text);
}

/** True when a fetched page is an anti-bot wall rather than content. */
function isAntiBotPage(text) {
	return ANTI_BOT.test(text) && text.length < 5000;
}

// --- mcp plumbing -----------------------------------------------------------

/**
 * Run one lightpanda MCP tool through the dsh-mcp-adapter `mcp` proxy tool and
 * return plain text.
 *
 * `ctx.tools.execute` takes a ToolExecutionInput whose `signal` field is
 * REQUIRED — omitting it crashes the registry with
 * "Cannot read properties of undefined (reading 'aborted')". We mint a local
 * controller and fuse the caller's signal in.
 *
 * The adapter's `mcp` tool is registered globally (not per preset), so we pass
 * the current agent via the `agents` service only to keep the call attributed
 * to the initiating agent; the tool itself resolves regardless of scope.
 *
 * Failure contract: the adapter never sets `isError` on a failed call — it
 * returns a normal text result prefixed with `Failed to call <tool>:`. We
 * detect that prefix and throw so the provider surfaces an honest error
 * instead of parsing the failure text as search results / page content.
 */
async function callLightpanda(ctx, tool, args, callerSignal) {
	const controller = new AbortController();
	let onAbort;
	if (callerSignal !== undefined) {
		if (callerSignal.aborted) controller.abort(callerSignal.reason);
		else {
			onAbort = () => controller.abort(callerSignal.reason);
			callerSignal.addEventListener("abort", onAbort, { once: true });
		}
	}
	try {
		const agent = ctx.agents.requireInitiator();
		// The mcporter bridge namespaces tools as `<server>__<tool>`, and the
		// adapter prefixes them with the bridge server name, so the lightpanda
		// tools are `m_lp__search`, `m_lp__goto`, `m_lp__markdown`.
		const mcTool = `${SERVER}_${MCPORTER_SERVER}__${tool}`;
		const result = await ctx.tools.execute({
			callId: `web-lightpanda-${crypto.randomUUID()}`,
			name: "mcp",
			arguments: { tool: mcTool, server: SERVER, args },
			agent,
			signal: controller.signal
		});
		if (result.isError) {
			throw new Error(`lightpanda ${tool} failed: ${result.error?.message ?? "unknown mcp error"}`);
		}
		const text = (result.content ?? [])
			.filter((block) => block && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		if (/^Failed to call /u.test(text)) {
			throw new Error(`lightpanda ${tool} failed: ${text}`);
		}
		return text;
	} finally {
		if (onAbort !== undefined) callerSignal.removeEventListener("abort", onAbort);
	}
}

// --- search result parsing --------------------------------------------------

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/;
// lightpanda's EXA path renders each result as a numbered line of the form
//   N. **title** — https://example.com/path — optional snippet
// (no markdown link syntax), so we also match a bare URL and a **bold** title.
const BARE_URL = /(https?:\/\/[^\s)\]]+)/;
const BOLD_TITLE = /\*\*([^*]+)\*\*/;

/**
 * Parse lightpanda's search markdown into WebSearchSource[]. The EXA path
 * renders a numbered list of "- [title](url) — snippet"-ish lines; parsing is
 * deliberately tolerant: lines without a markdown link are skipped, a bare-URL
 * title falls back to the URL itself, and duplicate URLs collapse.
 */
function parseSearchSources(text) {
	const sources = [];
	const seen = new Set();
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		// Prefer an explicit markdown link, else a bare URL anywhere in the line.
		const link = MARKDOWN_LINK.exec(line);
		const urlMatch = link ? null : BARE_URL.exec(line);
		if (!link && !urlMatch) continue;
		const url = link ? link[2] : urlMatch[1];
		if (seen.has(url)) continue;
		// DDG/tracking links are not citeable sources even outside the captcha page.
		if (/^https?:\/\/(html\.)?duckduckgo\.com\//.test(url)) continue;
		seen.add(url);
		// Title: markdown link text, else the **bold** span, else the URL itself.
		let title = link ? link[1] : "";
		if (!title) {
			const bold = BOLD_TITLE.exec(line);
			title = bold ? bold[1].trim() : "";
		}
		// Snippet: lightpanda's EXA path puts it on the NEXT line, indented
		// ("\n   "), so read the following line(s) until a non-indented one.
		let snippet = "";
		if (link) {
			snippet = line.slice(link.index + link[0].length);
		} else {
			const afterUrl = line.slice(urlMatch.index + url.length);
			snippet = afterUrl.replace(BOLD_TITLE, "").trim();
			if (!snippet) {
				for (let j = i + 1; j < lines.length; j++) {
					const next = lines[j];
					if (!next.trim()) break;
					if (!/^\s/.test(next)) break; // stop at a non-indented line
					snippet += (snippet ? " " : "") + next.trim();
				}
			}
		}
		snippet = snippet.replace(/^\s*[—–\-:]\s*/, "").trim();
		sources.push({
			url,
			...(title && title !== url ? { title } : {}),
			...(snippet ? { snippet } : {})
		});
	}
	return sources;
}

// --- providers ---------------------------------------------------------------

class LightpandaSearchProvider {
	id = PROVIDER_ID;
	constructor(ctx, maxSources) {
		this.ctx = ctx;
		this.maxSources = maxSources;
	}
	/** Cheap local check only (seam contract: no network calls here). */
	available() {
		return true;
	}
	async search(request, signal) {
		signal?.throwIfAborted();
		const text = await callLightpanda(this.ctx, "search", { query: request.query }, signal);
		signal?.throwIfAborted();
		if (isCaptchaPage(text)) {
			throw new Error(
				"lightpanda search returned a DuckDuckGo captcha page instead of results — " +
				"no search API key reached the browser process. Set EXA_API_KEY (or " +
				"BRAVE_API_KEY/TAVILY_API_KEY) in the lightpanda server env and restart the session."
			);
		}
		const sources = parseSearchSources(text);
		// Cap at the same count the seam's web_search tool returns (searchMaxResults),
		// so we never keep/parse more sources than the model actually sees.
		const truncated = sources.length > this.maxSources;
		return { sources: sources.slice(0, this.maxSources), truncated };
	}
}

class LightpandaFetchProvider {
	id = PROVIDER_ID;
	constructor(ctx) {
		this.ctx = ctx;
	}
	available() {
		return true;
	}
	async fetch(request, signal) {
		signal?.throwIfAborted();
		await callLightpanda(this.ctx, "goto", { url: request.url, timeout: GOTO_TIMEOUT_MS }, signal);
		signal?.throwIfAborted();
		let markdown = await callLightpanda(this.ctx, "markdown", {}, signal);
		signal?.throwIfAborted();
		if (isAntiBotPage(markdown)) {
			throw new Error(
				`lightpanda fetched an anti-bot verification page for ${request.url} ` +
				"(JS proof-of-work/captcha walls cannot be completed by this browser build)"
			);
		}
		let truncated = false;
		if (markdown.length > FETCH_MAX_CHARS) {
			markdown = markdown.slice(0, FETCH_MAX_CHARS);
			truncated = true;
		}
		return {
			url: request.url,
			statusCode: 200,
			body: { kind: "text", content: markdown },
			truncated
		};
	}
}

function apply(ctx, config) {
	// `web` is a GLOBAL singleton (mounted once by dsh-base). This plugin now
	// lives in the HOST composition (cordis.patch.yml), so it runs exactly once
	// at startup — the provider is registered once and the selection is
	// re-pointed once, globally. The idempotency guards below are kept as
	// defense in depth (e.g. profile reloads) and are harmless when the id is
	// already present.
	const web = ctx.web;
	// Cap size at the same value the seam's web_search tool returns
	// (tool-web `searchMaxResults`, default 8) so we never keep more than the
	// model sees. Override via this row's `config.maxSources`.
	const maxSources = Number.isInteger(config?.maxSources) && config.maxSources > 0
		? config.maxSources
		: 8;
	if (!web.searchProviders.has(PROVIDER_ID)) {
		web.registerSearchProvider(new LightpandaSearchProvider(ctx, maxSources));
	}
	if (!web.fetchProviders.has(PROVIDER_ID)) {
		web.registerFetchProvider(new LightpandaFetchProvider(ctx));
	}
	// Re-point the global seam (mounted by dsh-base with
	// `searchProvider: deepseek-official`) at this provider pair for as long as
	// the preset is active; restore the previous selection on dispose.
	ctx.effect(function* () {
		const prevSearch = web.searchProviderId;
		const prevFetch = web.fetchProviderId;
		web.searchProviderId = PROVIDER_ID;
		web.fetchProviderId = PROVIDER_ID;
		yield () => {
			web.searchProviderId = prevSearch;
			web.fetchProviderId = prevFetch;
		};
	});
}

export { apply, inject, name };
