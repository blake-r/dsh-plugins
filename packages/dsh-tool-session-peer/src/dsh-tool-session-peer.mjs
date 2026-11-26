// dsh-tool-session-peer.mjs
// Cordis plugin: peer messaging between adjacent top-level Sessions.
//
// Subagents can already talk to their parent and children (`send_message`,
// `@deepseek-ai/dsh-subagent`). Independent Sessions -- two GUI tabs, two
// terminal sessions -- had no channel: `ctx.subagents.sendMessage` enforces
// direct parent/child adjacency, and no model-facing tool lists or addresses an
// unrelated live Session.
//
// This plugin closes that gap with three tools:
//   - `session_peers` lists neighbouring non-archived top-level Sessions --
//     live or persisted/cold -- in the SAME workspace directory as the caller,
//     with id, title, status, cwd and preset;
//   - `session_send` resolves an exact session id or exact title, resuming a
//     persisted/cold recipient only when that exact target is addressed, then
//     delivers into its inbox (`agent.followup` or `agent.steer`);
//   - `session_broadcast` delivers one message to every neighbour at once.
//
// The two scopes deliberately differ. Discovery is workspace-local: an agent is
// told about the Sessions it shares a checkout with, not about every tab in the
// process. Delivery is process-wide by exact session id, so a Session introduced
// out of band can be answered even when it lives in another workspace. Exact
// titles resolve only among the caller's workspace peers.
//
// Delivery uses only public API (`ctx.agents.get`, `agent.followup/steer`,
// `createUserMessage`) -- no upstream patch of the subagent runtime, whose
// adjacency rule is load-bearing for delegation semantics.
//
// Attribution reuses the durable source kind the subagent runtime already
// defines for agent-to-agent content (`{ kind: 'agent-message', form: 'relay',
// senderSessionId }`), so a peer message renders as an agent-triggered turn in
// the receiving Session instead of impersonating its human user.
//
// Scope notes:
//   - Cold persisted Sessions are resumed only after an exact `session_send`
//     address; substring guesses and broadcasts never wake them.
//   - Archived Sessions are excluded from discovery and refused by delivery.
//     An archived Session can still have a live, idle Agent: the archive set
//     hides it from every grouping surface and the host `agent/pre-step` gate
//     rejects its steps, so a followup there would claim the message, run a
//     turn nobody can see, and drop the input unrun. Reporting `delivered`
//     for that would be a lie, hence the explicit refusal.
//   - Only runtime roots are listed, so another Session's subagent children stay
//     private to it. Root-ness is read from the persisted session header: a
//     child carries a non-zero `delegationDepth`, a top-level Session carries
//     none (or zero). The registry no longer answers ownership questions and a
//     registry agent is a bare handle, so the header is read directly rather
//     than through `@deepseek-ai/dsh-subagent`'s `delegationDepthOf`, which also
//     consults runtime agent options that DSH 0.2.2 does not expose there.
//
// ── schema format ───────────────────────────────────────────────────────────
// Tools register through raw JSON Schema (`ctx.tools.register`, not
// `defineTool`): per-property `required: true` is rejected outside object
// nodes, so both `parameters` and `output.schema` carry a top-level
// `required` array.

const name = "dsh-tool-session-peer";
const inject = ["tools", "agents", "sessionQuery"];

const MAX_MESSAGE_BYTES = 32768;
const RATE_WINDOW_MS = 60000;
const RATE_MAX_MESSAGES = 20;

class PeerError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "PeerError";
  }
}

const PEERS_DESCRIPTION =
  "List neighbouring non-archived top-level Sessions in the same workspace directory as this one, excluding this Session, every subagent child, and empty UI drafts without a user message. Includes conversation-bearing live Sessions (idle or running) and cold persisted Sessions (status cold). Each row gives the exact session id and exact title to pass to session_send, plus working directory and preset.";

const SEND_DESCRIPTION =
  "Send one message to another non-archived Session (a peer agent): the cross-Session counterpart of send_message between subagents. Supply the exact session id or exact title; a cold persisted target is resumed only on this exact address. A running target receives the message at its nearest step boundary; otherwise it is queued as that Session's next turn. The target sees your session id and can answer with session_send back to you. An archived target is refused.";

const BROADCAST_DESCRIPTION =
  "Send one message to every neighbouring live Session in this workspace at once. Cold persisted Sessions listed by session_peers are skipped rather than resumed; use session_send with that Session's exact id or exact title to address one explicitly. This Session, subagent children, and archived Sessions are excluded. Use it for announcements that concern the whole checkout; prefer session_send when only one peer needs the message.";

const PEERS_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      peers: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            status: { type: "string" },
            cwd: { type: "string" },
            preset: { type: "string" }
          },
          required: ["id", "title", "status"]
        }
      }
    },
    required: ["text", "peers"]
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

const SEND_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      delivered: { type: "boolean" },
      targetSessionId: { type: "string" },
      targetTitle: { type: "string" },
      mode: { type: "string" }
    },
    required: ["text", "delivered", "mode"]
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

const BROADCAST_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      delivered: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            mode: { type: "string" }
          },
          required: ["id", "mode"]
        }
      },
      failed: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            error: { type: "string" }
          },
          required: ["id", "error"]
        }
      }
    },
    required: ["text", "delivered", "failed"]
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

/** Read one Session's latest folded title without failing on an absent service. */
function titleOf(ctx, session) {
  try {
    const service = ctx.get("sessionTitle");
    const snapshot = service?.get?.(session);
    return typeof snapshot?.title === "string" ? snapshot.title : "";
  } catch {
    return "";
  }
}

/** Describe one live Agent as an addressable peer row. */
function peerRow(ctx, agent) {
  const header = agent.session?.header ?? {};
  return {
    id: String(agent.id),
    title: titleOf(ctx, agent.session),
    status: String(agent.status ?? "unknown"),
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    preset: typeof header.agentPreset === "string" ? header.agentPreset : ""
  };
}

/**
 * Delegation depth recorded in one Agent's session header.
 *
 * Absent, non-numeric or zero all mean "top-level": older persisted sessions
 * predate the field, and a missing header must never throw here.
 */
function headerDelegationDepth(agent) {
  const depth = agent?.session?.header?.delegationDepth;
  return typeof depth === "number" && Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * The workspace registry's durable archive set, as a Set of session ids.
 *
 * The registry is optional: a composition without `@deepseek-ai/dsh-workspace`
 * has no archive concept, and an absent service must read as "nothing is
 * archived" rather than hide every peer.
 */
function archivedSessionIds(ctx) {
  try {
    const registry = ctx.get("workspaceRegistry");
    const ids = registry?.archivedSessionIds;
    return Array.isArray(ids) ? new Set(ids.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

/** Whether one Session id is in the archive set. */
function isArchived(ctx, id) {
  return archivedSessionIds(ctx).has(String(id));
}

/** Session ids accounted to registered workspaces; without that index, cold ids are not exposed. */
function workspaceSessionIds(ctx) {
  try {
    const registry = ctx.get("workspaceRegistry");
    if (typeof registry?.list !== "function") return new Set();
    return new Set(registry.list().flatMap((workspace) => workspace.sessionIds.map(String)));
  } catch {
    return new Set();
  }
}

/** The caller's workspace directory, or an empty string when it has none. */
function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" ? cwd : "";
}

/**
 * All conversation-bearing top-level Sessions: runtime Agents plus persisted
 * records. Empty UI drafts are omitted until their first user/message event;
 * cold Sessions with history are included without making them live.
 */
async function sessionRows(ctx, selfId) {
  let records = [];
  try {
    records = await ctx.sessionQuery.listSessions();
  } catch (error) {
    throw new PeerError(
      `could not list persisted Sessions: ${error instanceof Error ? error.message : String(error)}`,
      "PEER_SESSION_LIST_FAILED"
    );
  }
  const byId = new Map();
  for (const agent of ctx.agents.list()) {
    const id = String(agent.id);
    if (id === selfId || headerDelegationDepth(agent) !== 0) continue;
    byId.set(id, {
      ...peerRow(ctx, agent),
      live: true,
      persisted: false
    });
  }
  const accountedIds = workspaceSessionIds(ctx);
  const rootRecords = records.filter((record) => {
    const header = record?.header;
    const id = header?.id === undefined ? "" : String(header.id);
    return id !== "" && id !== selfId && headerDelegationDepth({ session: { header } }) === 0 &&
      (record.live === true || record.persisted === true) && accountedIds.has(id);
  });
  const candidates = new Map(byId);
  for (const record of rootRecords) {
    const header = record.header;
    const id = String(header.id);
    const liveAgent = ctx.agents.get(id);
    const prior = candidates.get(id);
    candidates.set(id, {
      id,
      title: prior?.title ?? "",
      status: liveAgent?.status ?? "cold",
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      preset: typeof header.agentPreset === "string" ? header.agentPreset : "",
      live: liveAgent !== undefined,
      persisted: record.persisted === true
    });
  }
  const nonblankIds = new Set();
  await Promise.all([...candidates.keys()].map(async (id) => {
    try {
      const events = await ctx.sessionQuery.listEvents(id);
      if (events.some((event) => event.type === "user/message")) nonblankIds.add(id);
    } catch {
      // Do not expose a target when its conversation history cannot be verified.
    }
  }));
  for (const id of candidates.keys()) {
    if (!nonblankIds.has(id)) candidates.delete(id);
  }
  let titles = [];
  const eligibleRecords = rootRecords.filter((record) => nonblankIds.has(String(record.header.id)));
  try {
    titles = await ctx.sessionQuery.readTitleSnapshots(eligibleRecords.map((record) => String(record.header.id)));
  } catch {
    titles = [];
  }
  const titleById = new Map(
    titles.filter((entry) => entry.status === "fulfilled")
      .map((entry) => [String(entry.sessionId), entry.value.title?.title ?? ""])
  );
  for (const record of eligibleRecords) {
    const id = String(record.header.id);
    const prior = candidates.get(id);
    candidates.set(id, { ...prior, title: titleById.get(id) ?? prior?.title ?? "" });
  }
  return [...candidates.values()];
}

/** Non-archived peers in the caller's workspace; an unknown cwd sees all. */
async function peersOf(ctx, agent) {
  const rows = await sessionRows(ctx, String(agent.id));
  const archived = archivedSessionIds(ctx);
  const visible = rows.filter((row) => !archived.has(row.id));
  const cwd = workspaceOf(agent);
  if (cwd === "") return visible;
  return visible.filter((row) => row.cwd === cwd);
}

/** Render one peer row as a single model-facing line. */
function formatPeer(row) {
  const parts = [`- ${row.id}`, row.status];
  if (row.title !== "") parts.push(`"${row.title}"`);
  if (row.preset !== "") parts.push(`preset=${row.preset}`);
  if (row.cwd !== "") parts.push(row.cwd);
  return parts.join(" | ");
}

/** Resolve an exact session id or exact title, never a guessed fragment. */
function resolveTarget(live, scoped, raw) {
  const wanted = String(raw ?? "").trim();
  if (wanted === "") throw new PeerError("target must not be empty", "PEER_TARGET_REQUIRED");
  const exactId = live.find((row) => row.id === wanted);
  if (exactId !== undefined) return exactId;
  const exactTitle = scoped.filter((row) => row.title === wanted);
  if (exactTitle.length === 1) return exactTitle[0];
  if (exactTitle.length > 1) {
    throw new PeerError(
      `title "${wanted}" matches multiple Sessions; pass the exact session id:\n${exactTitle.map(formatPeer).join("\n")}`,
      "PEER_TARGET_AMBIGUOUS"
    );
  }
  throw new PeerError(
    scoped.length === 0
      ? `no Session exactly matches "${wanted}"; there are no non-archived peers in this workspace right now`
      : `no Session exactly matches "${wanted}"; pass an exact session id or title:\n${scoped.map(formatPeer).join("\n")}`,
    "PEER_TARGET_NOT_FOUND"
  );
}

/** Build the model-visible body delivered into the target Session. */
function composeBody(senderId, senderTitle, message) {
  const label = senderTitle === "" ? senderId : `${senderId} "${senderTitle}"`;
  return [
    `[peer message from session ${label}]`,
    message,
    "",
    `To answer, call session_send with target "${senderId}".`
  ].join("\n");
}

/** Sliding-window rate limiter keyed by sending Session id. */
class RateLimiter {
  #hits = new Map();

  /**
   * Record `count` accepted deliveries or reject when they would exceed this
   * sender's window budget. A broadcast reserves its whole fan-out up front so
   * it either goes out completely or not at all.
   */
  admit(senderId, count = 1) {
    const now = Date.now();
    const recent = (this.#hits.get(senderId) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
    if (recent.length + count > RATE_MAX_MESSAGES) {
      throw new PeerError(
        `rate limit reached (${RATE_MAX_MESSAGES} messages per ${RATE_WINDOW_MS / 1000}s); wait before sending again`,
        "PEER_RATE_LIMITED"
      );
    }
    for (let index = 0; index < count; index += 1) recent.push(now);
    this.#hits.set(senderId, recent);
  }

  /** Drop state for Sessions that stopped sending long ago. */
  prune() {
    const now = Date.now();
    for (const [key, times] of this.#hits) {
      if (times.every((time) => now - time >= RATE_WINDOW_MS)) this.#hits.delete(key);
    }
  }
}

/** Build the model-facing peer list payload for one calling Session. */
async function peersPayload(ctx, agent) {
  const rows = await peersOf(ctx, agent);
  const text =
    rows.length === 0
      ? "(no other non-archived Sessions in this workspace)"
      : `${rows.length} other non-archived Session(s) in this workspace:\n${rows.map(formatPeer).join("\n")}`;
  const peers = rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    ...(row.cwd === "" ? {} : { cwd: row.cwd }),
    ...(row.preset === "" ? {} : { preset: row.preset })
  }));
  return { text, peers };
}

/** Resolve the calling Agent or fail with a stable code. */
function requireAgent(exec, toolName) {
  const agent = exec.agent;
  if (agent === undefined || agent === null) {
    throw new PeerError(`${toolName} requires a calling agent with a session`, "PEER_AGENT_REQUIRED");
  }
  return agent;
}

/** Validate one outgoing message and return it trimmed with its byte size. */
function requireMessage(args) {
  const message = String(args.message ?? "").trim();
  if (message === "") throw new PeerError("message must not be empty", "PEER_MESSAGE_REQUIRED");
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new PeerError(
      `message is ${bytes} bytes; the limit is ${MAX_MESSAGE_BYTES}`,
      "PEER_MESSAGE_TOO_LARGE"
    );
  }
  return { message, bytes };
}

/** Resume one persisted peer on exact addressing, sharing concurrent resumes. */
async function resumePeer(ctx, row, resumes) {
  const current = ctx.agents.get(row.id);
  if (current !== undefined) return current;
  if (!row.persisted || typeof ctx.agents.resume !== "function") {
    throw new PeerError(`Session "${row.id}" is no longer available`, "PEER_TARGET_GONE");
  }
  let pending = resumes.get(row.id);
  if (pending === undefined) {
    pending = (async () => {
      if (isArchived(ctx, row.id)) {
        throw new PeerError(`Session "${row.id}" is archived and will not be resumed`, "PEER_TARGET_ARCHIVED");
      }
      let presetId;
      try {
        const observation = await ctx.sessionQuery.observeSession(row.id);
        presetId = observation?.projections?.values?.agentPreset ?? observation?.header?.agentPreset;
      } catch (error) {
        throw new PeerError(
          `could not inspect persisted Session "${row.id}" before resuming: ${error instanceof Error ? error.message : String(error)}`,
          "PEER_TARGET_RESUME_FAILED"
        );
      }
      let presets;
      try {
        presets = ctx.get("agentPresets");
      } catch {
        presets = undefined;
      }
      const setup = async (agentCtx) => {
        if (presets && typeof presets.mount === "function" && presetId) {
          const resolved = await presets.resolve(presetId);
          await presets.mount(agentCtx, resolved.id);
        }
      };
      let selection = {};
      try {
        selection = ctx.agentDefaultModel?.currentSelection?.() ?? {};
      } catch {
        selection = {};
      }
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: row.id,
          agentOptions: {
            ...(selection.provider ? { provider: selection.provider } : {}),
            ...(selection.model ? { model: selection.model } : {})
          },
          setup
        });
        return handle?.agent ?? ctx.agents.get(row.id);
      } catch (error) {
        throw new PeerError(
          `could not resume persisted Session "${row.id}": ${error instanceof Error ? error.message : String(error)}`,
          "PEER_TARGET_RESUME_FAILED"
        );
      }
    })();
    resumes.set(row.id, pending);
  }
  try {
    const resumed = await pending;
    if (resumed === undefined) throw new PeerError(`Session "${row.id}" did not become live`, "PEER_TARGET_GONE");
    return resumed;
  } finally {
    if (resumes.get(row.id) === pending) resumes.delete(row.id);
  }
}

/** Deliver one validated message into one resolved peer row and describe the outcome. */
async function sendToPeer(ctx, resumes, createUserMessage, senderId, senderTitle, row, message) {
  const targetAgent = await resumePeer(ctx, row, resumes);
  if (isArchived(ctx, row.id)) {
    throw new PeerError(`Session "${row.id}" is archived and will not receive a message`, "PEER_TARGET_ARCHIVED");
  }
  const mode = targetAgent.status === "running" ? "steer" : "followup";
  const userMessage = createUserMessage({
    content: [{ type: "text", text: composeBody(senderId, senderTitle, message) }],
    source: { kind: "agent-message", form: "relay", senderSessionId: senderId }
  });
  if (mode === "steer") {
    await targetAgent.steer(userMessage);
  } else {
    await targetAgent.followup(userMessage);
  }
  return { id: row.id, title: row.title, mode };
}

/** Deliver one peer message into the target Session and describe the outcome. */
async function deliverPeer(ctx, limiter, resumes, createUserMessage, exec, args) {
  const sender = requireAgent(exec, "session_send");
  const senderId = String(sender.id);
  const { message, bytes } = requireMessage(args);
  limiter.admit(senderId);
  const all = await sessionRows(ctx, senderId);
  const archived = archivedSessionIds(ctx);
  const cwd = workspaceOf(sender);
  const scoped = all.filter((row) => !archived.has(row.id) && (cwd === "" || row.cwd === cwd));
  const target = resolveTarget(all, scoped, args.target);
  if (isArchived(ctx, target.id)) {
    throw new PeerError(
      `Session "${target.id}" is archived; its steps are rejected by the host gate, so a message would be dropped unrun. Unarchive it in the GUI first or pick another peer`,
      "PEER_TARGET_ARCHIVED"
    );
  }
  const sent = await sendToPeer(ctx, resumes, createUserMessage, senderId, titleOf(ctx, sender.session), target, message);
  return {
    text:
      `Delivered to ${sent.id}${sent.title === "" ? "" : ` "${sent.title}"`} ` +
      `via ${sent.mode} (${bytes} bytes). The target can answer with session_send target="${senderId}".`,
    delivered: true,
    targetSessionId: sent.id,
    ...(sent.title === "" ? {} : { targetTitle: sent.title }),
    mode: sent.mode
  };
}

/** Broadcast to live peers only; cold persisted peers require exact addressing. */
async function broadcastPeers(ctx, limiter, resumes, createUserMessage, exec, args) {
  const sender = requireAgent(exec, "session_broadcast");
  const senderId = String(sender.id);
  const { message } = requireMessage(args);
  const targets = await peersOf(ctx, sender);
  const liveTargets = targets.filter((row) => ctx.agents.get(row.id) !== undefined);
  const coldTargets = targets.filter((row) => ctx.agents.get(row.id) === undefined);
  if (targets.length === 0) {
    return {
      text: "(no other non-archived Sessions in this workspace; nothing was sent)",
      delivered: [],
      failed: []
    };
  }
  if (liveTargets.length > 0) limiter.admit(senderId, liveTargets.length);
  const senderTitle = titleOf(ctx, sender.session);
  const delivered = [];
  const failed = coldTargets.map((row) => ({
    id: row.id,
    error: "cold session skipped; address its exact id or title with session_send to resume it"
  }));
  for (const row of liveTargets) {
    try {
      delivered.push(await sendToPeer(ctx, resumes, createUserMessage, senderId, senderTitle, row, message));
    } catch (error) {
      failed.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const lines = delivered.map(
    (entry) => `- ${entry.id} | ${entry.mode}${entry.title === "" ? "" : ` | "${entry.title}"`}`
  );
  for (const entry of failed) lines.push(`- ${entry.id} | SKIPPED/FAILED | ${entry.error}`);
  return {
    text:
      `Broadcast delivered to ${delivered.length} of ${liveTargets.length} live peer(s); ` +
      `${coldTargets.length} cold peer(s) skipped:\n${lines.join("\n")}` +
      (failed.length === 0 ? "" : `\n${failed.length} peer(s) were skipped or failed; see the rows above.`),
    delivered,
    failed
  };
}

/** Build both tool definitions against one plugin instance state. */
function defineTools(ctx, resolveCreateUserMessage) {
  const limiter = new RateLimiter();
  const resumes = new Map();

  const peersTool = {
    name: "session_peers",
    description: PEERS_DESCRIPTION,
    parameters: { type: "object", properties: {}, required: [] },
    output: PEERS_OUTPUT,
    async execute(_args, exec) {
      const agent = requireAgent(exec, "session_peers");
      limiter.prune();
      return await peersPayload(ctx, agent);
    },
    presentCall() {
      return { card: "generic", title: "List peer sessions", kind: "read", rawInput: "" };
    }
  };

  const sendTool = {
    name: "session_send",
    description:
      SEND_DESCRIPTION +
      ' Target must exactly match a session id or an exact title from session_peers.',
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            'Recipient Session as returned by session_peers; provide its exact session id or exact title.'
        },
        message: {
          type: "string",
          description:
            "Self-contained message for the target Session. It cannot see your conversation, so include every fact it needs and say what you want back."
        }
      },
      required: ["target", "message"]
    },
    output: SEND_OUTPUT,
    async execute(args, exec) {
      const createUserMessage = await resolveCreateUserMessage();
      return deliverPeer(ctx, limiter, resumes, createUserMessage, exec, args);
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `Send to peer ${String(args?.target ?? "")}`,
        kind: "write",
        rawInput: String(args?.message ?? "")
      };
    }
  };

  const broadcastTool = {
    name: "session_broadcast",
    description: BROADCAST_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Self-contained message for every peer in this workspace. No peer can see your conversation, so include every fact they need and say what you want back."
        }
      },
      required: ["message"]
    },
    output: BROADCAST_OUTPUT,
    async execute(args, exec) {
      const createUserMessage = await resolveCreateUserMessage();
      return broadcastPeers(ctx, limiter, resumes, createUserMessage, exec, args);
    },
    presentCall(args) {
      return {
        card: "generic",
        title: "Broadcast to peer sessions",
        kind: "write",
        rawInput: String(args?.message ?? "")
      };
    }
  };

  return [peersTool, sendTool, broadcastTool];
}

function apply(ctx) {
  let createUserMessagePromise;
  // Resolve @deepseek-ai/dsh-llm through the composition loader so this package
  // stays dependency-free (same pattern as dsh-tool-trajectory-recall).
  const resolveCreateUserMessage = () => {
    if (createUserMessagePromise === undefined) {
      createUserMessagePromise = Promise.resolve()
        .then(async () => {
          const loader = ctx.loader;
          if (loader === undefined || loader === null || typeof loader.import !== "function") return undefined;
          const mod = await loader.import("@deepseek-ai/dsh-llm");
          return mod !== null && mod !== void 0 && typeof mod.createUserMessage === "function"
            ? mod.createUserMessage
            : undefined;
        })
        .then((fn) => fn ?? fallbackCreateUserMessage)
        .catch(() => fallbackCreateUserMessage);
    }
    return createUserMessagePromise;
  };
  ctx.effect(() => {
    const disposers = defineTools(ctx, resolveCreateUserMessage).map((definition) =>
      ctx.tools.register(definition)
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}

/** Structural stand-in used only when the llm module cannot be resolved. */
function fallbackCreateUserMessage(input) {
  return Object.freeze({
    id: globalThis.crypto.randomUUID(),
    role: "user",
    content: Object.freeze(input.content.map((block) => Object.freeze({ ...block }))),
    source: Object.freeze({ ...input.source })
  });
}

export { apply, inject, name };
