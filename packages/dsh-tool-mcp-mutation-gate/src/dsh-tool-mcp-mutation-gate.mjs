// dsh-tool-mcp-mutation-gate — per-server confirmation gate for mutating MCP
// tools.
//
// Mounted once per MCP server (one row per server in a preset's
// agent.cordis.yml, pattern dsh-command-from-prompt: one plugin, many rows,
// each with its own config). It intercepts `tools/pre-execute` for tools of
// the configured server and asks the user to confirm mutating calls.
//
// Config shape:
//   config:
//     server: <mcp serverName>          # required; matches mcp__<server>__*
//     heuristics?: [<word|/regex/>, ...] # default DEFAULT_HEURISTICS
//     commands: { <rawName>: ask|allow|deny }
//
// Resolution order for a tool mcp__<server>__<rawName>:
//   1. commands[rawName] === "allow" -> next() (no gate)
//   2. commands[rawName] === "deny"  -> { kind: "deny", reason } (hard no,
//      no prompt; used for read-only policies on a server)
//   3. commands[rawName] === "ask"   -> { kind: "ask", reason } unless a
//      time-limited grant covers the call (see below)
//   4. else heuristic: rawName matches any of `heuristics` -> ask (same
//      grant check), otherwise next()
//
// Heuristic entries are plain words matched at letter/digit boundaries
// (underscore counts as a separator, unlike JS \b which treats it as a word
// char), or full regexes when written as /pattern/flags. Boundaries keep
// "comment" from catching read-only "list_*_comments"; use "/comments/" if a
// server ever needs the plural matched.
//
// Time-limited grants ("For 1h"): the approval dialog (patched
// @deepseek-ai/dsh-client-ui-approval) offers Deny / Accept / "For 1h"
// checkbox. When the user accepts with the checkbox ticked, the client calls
// the shared /api RPC channel (endpoint "mutation-gate/remember") with
// { toolName, sessionId, callId? }; the plugin correlates the ask against the
// pending entries it recorded in `tools/pre-execute` (keyed by
// sessionId+toolName; callId is an optional hint, never a gate — mcp tools do
// not reliably carry a string callId at pre-execute time), then writes a
// grant for that sessionId+toolName with TTL GRANT_TTL_MS (1h). Subsequent
// calls of the same tool in the same session pass without a prompt until the
// grant expires.
// Grants live in module-level memory (shared by all mounts through the ESM
// cache) and die with the process; a new session starts with an empty grant
// map. There is no auto-remember after a successful call anymore — a grant is
// written only by the explicit "For 1h" choice.
//
// The harness approval seam (policy `ask`) turns the returned `ask` decision
// into a confirmation card in the web UI. Enforcement follows the
// dsh-tool-filter-root-find pattern.

const name = "dsh-tool-mcp-mutation-gate";
const inject = ["tools", "connection"];

const DEFAULT_HEURISTICS = [
  "create",
  "update",
  "delete",
  "set",
  "add",
  "remove",
  "move",
  "send",
  "post",
  "comment",
  "reply",
  "clear",
  "upload",
  "manage",
  "insert",
  "import",
  "replace",
  "modify",
  "copy",
  "append",
  "prepend",
];

// Compile heuristic entries into a matcher. Plain words are anchored at
// letter/digit boundaries (underscore counts as a separator, unlike JS \b
// which treats it as a word char), so a plural like "comments" does not trip
// the singular "comment"; an entry written as /pattern/flags is used verbatim.
function compileHeuristics(list) {
  const words = [];
  const regexes = [];
  for (const h of list) {
    const m = /^\/(.*)\/([a-z]*)$/.exec(h);
    if (m !== null) {
      try {
        regexes.push(new RegExp(m[1], m[2] || "i"));
      } catch {
        // invalid regex: ignore the entry
      }
    } else {
      words.push(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  const wordRe = words.length > 0
    ? new RegExp(`(?:^|(?<![a-z0-9]))(?:${words.join("|")})(?![a-z0-9])`, "i")
    : null;
  return (raw) =>
    (wordRe !== null && wordRe.test(raw)) || regexes.some((re) => re.test(raw));
}

const GRANT_TTL_MS = 60 * 60 * 1000; // 1 hour
const PENDING_TTL_MS = 60 * 60 * 1000; // abandoned dialogs expire after 1h

// RPC endpoint on the shared /api channel. The client's
// connection.rpc.call("/api", endpoint, payload) POSTs /api/<endpoint> and
// sets envelope.method to the FULL endpoint ("mutation-gate/remember"), not
// just its last segment — the method check below must compare against this.
const RPC_ENDPOINT = "mutation-gate/remember";

// Single-sourced marker appended to the ask reason; the client patch renders
// the "For 1h" checkbox only for asks carrying this suffix. Keep the literal
// in the patch file in sync with this constant.
const MUTATION_GATE_REASON_SUFFIX = "— mutating operation, confirmation required";

// Module-level shared state: the ESM cache executes the module once even
// though `apply` runs once per mounted row, so all five server mounts share
// these maps. Grants are keyed by session id, then by full tool name.
const grants = new Map(); // sessionId -> Map<toolName, expiresAt>
const pending = new Map(); // sessionId::toolName -> { toolName, sessionId, callId?, expiresAt }
let rpcRegistered = false;

// Lazy prune: drop expired pending entries on access (no timer). Called from
// pre-execute and remember.
function prunePending(now = Date.now()) {
  for (const [key, rec] of pending) {
    if (rec.expiresAt <= now) pending.delete(key);
  }
}

function apply(ctx, config) {
  const server = typeof config?.server === "string" ? config.server : "";
  const commands =
    config?.commands && typeof config.commands === "object" ? config.commands : {};
  const matches = compileHeuristics(
    Array.isArray(config?.heuristics) && config.heuristics.length > 0
      ? config.heuristics.map((h) => String(h).toLowerCase())
      : DEFAULT_HEURISTICS,
  );

  const prefix = `mcp__${server}__`;
  const publicName = (raw) => `${prefix}${raw}`;
  const disposers = [];

  // Register the /mutation-gate RPC endpoint once (guard against the 5 mounts).
  // The generic rpc.handle path requires `webServer` injected into the
  // connection plugin's own context, which this deployment does not provide,
  // so we mount an exact Fetch route on the shared /api transport instead:
  // client `connection.rpc.call("/api", "mutation-gate/remember", payload)`
  // POSTs /api/mutation-gate/remember, which the connection plugin's /api
  // route admits and routes to this exact route.
  if (!rpcRegistered) {
    rpcRegistered = true;
    const remember = (payload) => {
      const { toolName, callId, sessionId: payloadSessionId } = payload ?? {};
      if (typeof toolName !== "string" || typeof payloadSessionId !== "string") {
        return {
          ok: false,
          error: { code: "mutation-gate/bad-payload", message: "remember requires toolName and sessionId", details: {} },
        };
      }
      if (callId !== void 0 && typeof callId !== "string") {
        return {
          ok: false,
          error: { code: "mutation-gate/bad-payload", message: "callId must be a string when present", details: {} },
        };
      }
      prunePending();
      // Correlate the ask: (2) pending entry by callId, else (3) the most
      // recent pending entry for the tool. The grant sessionId comes from the
      // payload (1) — the client sends pending.sessionId, which equals the
      // server's exec.agent.session.id — falling back to the entry's.
      let rec;
      if (callId !== void 0) {
        for (const entry of pending.values()) {
          if (entry.callId === callId && entry.toolName === toolName) {
            rec = entry;
            break;
          }
        }
      }
      if (rec === void 0) {
        for (const entry of pending.values()) {
          if (entry.toolName !== toolName) continue;
          if (rec === void 0 || entry.expiresAt > rec.expiresAt) rec = entry;
        }
      }
      if (rec === void 0) {
        return {
          ok: false,
          error: { code: "mutation-gate/unknown-call", message: `no pending ask for tool ${toolName}`, details: {} },
        };
      }
      const sessionId = payloadSessionId ?? rec.sessionId;
      pending.delete(`${rec.sessionId}::${rec.toolName}`);
      let byTool = grants.get(sessionId);
      if (byTool === void 0) {
        byTool = new Map();
        grants.set(sessionId, byTool);
      }
      byTool.set(toolName, Date.now() + GRANT_TTL_MS);
      return { ok: true, value: { accepted: true } };
    };
    const rpcDisposer = ctx.connection.fetch.register({
      path: "/api/mutation-gate/remember",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response("body is not JSON", { status: 400 });
        }
        const envelope = body;
        if (envelope?.type !== "client-request" || typeof envelope.rpcId !== "string" || typeof envelope.method !== "string") {
          const rpcId = typeof envelope?.rpcId === "string" ? envelope.rpcId : "invalid-request";
          return new Response(JSON.stringify({
            type: "server-response",
            rpcId,
            result: { ok: false, error: { code: "gateway/bad-request", message: "invalid client-request message", details: {} } },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (envelope.method !== RPC_ENDPOINT) {
          return new Response(JSON.stringify({
            type: "server-response",
            rpcId: envelope.rpcId,
            result: {
              ok: false,
              error: {
                code: "gateway/bad-request",
                message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${RPC_ENDPOINT}`,
                details: {},
              },
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        try {
          const result = remember(envelope.payload);
          return new Response(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          return new Response(`handler failure: ${String(error)}`, { status: 500 });
        }
      },
    });
    disposers.push(rpcDisposer);
  }

  disposers.push(
    ctx.on(
      "tools/pre-execute",
      (exec, next) => {
        if (typeof exec?.name !== "string" || !exec.name.startsWith(prefix)) {
          return next();
        }
        const raw = exec.name.slice(prefix.length);
        const cmd = commands[raw];
        if (cmd === "allow") return next();
        if (cmd === "deny") {
          return {
            kind: "deny",
            reason: `${publicName(raw)} is blocked — ${server} is read-only for this operation.`,
          };
        }
        if (cmd === "ask" || matches(raw)) {
          const sessionId = exec.agent?.session?.id;
          const byTool = sessionId === void 0 ? void 0 : grants.get(sessionId);
          const expiresAt = byTool?.get(exec.name);
          if (expiresAt !== void 0 && expiresAt > Date.now()) return next();
          if (sessionId !== void 0) {
            prunePending();
            pending.set(`${sessionId}::${exec.name}`, {
              toolName: exec.name,
              sessionId,
              callId: typeof exec.callId === "string" ? exec.callId : void 0,
              expiresAt: Date.now() + PENDING_TTL_MS,
            });
          }
          return {
            kind: "ask",
            reason: `${publicName(raw)}${MUTATION_GATE_REASON_SUFFIX}`,
          };
        }
        return next();
      },
      { prepend: true },
    ),
  );

  // NOTE: no tools/post-execute auto-remember anymore. A grant is written
  // only by the explicit "For 1h" choice in the approval dialog (RPC
  // "remember"), so a failed call does not silently unlock the tool.

  // Disposer so HMR re-apply unregisters listeners before re-registering them.
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
    // A re-apply stops and restarts the service without re-importing the
    // module, so the module-level guard would stay true and the fetch route
    // would never re-register. Reset it so the next mount re-registers.
    rpcRegistered = false;
  };
}

export { MUTATION_GATE_REASON_SUFFIX, apply, inject, name };