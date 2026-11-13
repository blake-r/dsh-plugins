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
//   - `session_peers` lists the neighbouring live top-level Sessions -- those
//     working in the SAME workspace directory as the caller -- with id, title,
//     status, cwd and preset;
//   - `session_send` delivers one model-authored message into another live
//     Session's inbox (`agent.followup` queues a turn, `agent.steer` delivers at
//     the nearest step boundary), waking an idle peer;
//   - `session_broadcast` delivers one message to every neighbour at once.
//
// The two scopes deliberately differ. Discovery is workspace-local: an agent is
// told about the Sessions it shares a checkout with, not about every tab in the
// process. Delivery is process-wide: any exact live session id resolves, so a
// Session that was introduced out of band (a message it received, a user note)
// can be answered even when it lives in another workspace. That wider reach is
// intentionally NOT advertised in either tool description.
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
//   - Only live Sessions are addressable; a cold (persisted, not running)
//     Session is not resumed here -- waking someone else's tab from disk would
//     mount its preset behind its owner's back.
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
const inject = ["tools", "agents"];

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
  "List the neighbouring live Sessions: other top-level Sessions working in the same workspace directory as this one, excluding this Session, every subagent child, and archived Sessions. Each row gives the exact session id to pass to session_send, plus its title, status (idle or running), working directory, and preset.";

const SEND_DESCRIPTION =
  "Send one message to another live Session (a peer agent): the cross-Session counterpart of send_message between subagents. A running target receives it at its nearest step boundary with mode=steer; otherwise it is queued as that Session's next turn and wakes an idle target. The target sees your session id and can answer with session_send back to you. An archived target is refused rather than woken.";

const BROADCAST_DESCRIPTION =
  "Send one message to every neighbouring live Session in this workspace at once: the same delivery as session_send, fanned out to all peers listed by session_peers (this Session, subagent children, and archived Sessions excluded). Each target receives it independently -- a running one at its nearest step boundary with mode=steer, an idle one as its next turn. Use it for announcements that concern the whole checkout; prefer session_send when only one peer needs the message.";

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

/** Every live top-level Agent except one exact Session id, in registration order. */
function livePeers(ctx, selfId) {
  const rows = [];
  for (const agent of ctx.agents.list()) {
    if (String(agent.id) === selfId) continue;
    if (headerDelegationDepth(agent) !== 0) continue;
    rows.push(peerRow(ctx, agent));
  }
  return rows;
}

/** The caller's workspace directory, or an empty string when it has none. */
function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" ? cwd : "";
}

/**
 * Peers that share the caller's workspace directory and are not archived. A
 * caller without a known workspace cannot be scoped, so it sees every live root
 * instead of nothing.
 */
function peersOf(ctx, agent) {
  const rows = livePeers(ctx, String(agent.id));
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

/**
 * Resolve one target reference.
 *
 * An exact live session id resolves anywhere in the process -- that is the
 * delivery scope. Title and id-fragment matching stays inside `scoped`, the
 * caller's workspace neighbours, so a guess can never land in another
 * workspace by coincidence. A failed lookup enumerates only `scoped`.
 */
function resolveTarget(live, scoped, raw) {
  const wanted = String(raw ?? "").trim();
  if (wanted === "") throw new PeerError("target must not be empty", "PEER_TARGET_REQUIRED");
  const exactId = live.find((row) => row.id === wanted);
  if (exactId !== undefined) return exactId;
  const lowered = wanted.toLowerCase();
  const exactTitle = scoped.filter((row) => row.title.toLowerCase() === lowered);
  if (exactTitle.length === 1) return exactTitle[0];
  const partial = scoped.filter(
    (row) => row.title.toLowerCase().includes(lowered) || row.id.toLowerCase().includes(lowered)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) {
    throw new PeerError(
      scoped.length === 0
        ? `no live Session matches "${wanted}"; there are no peers in this workspace right now`
        : `no live Session matches "${wanted}"; peers in this workspace:\n${scoped.map(formatPeer).join("\n")}`,
      "PEER_TARGET_NOT_FOUND"
    );
  }
  throw new PeerError(
    `target "${wanted}" is ambiguous; pass an exact session id:\n${partial.map(formatPeer).join("\n")}`,
    "PEER_TARGET_AMBIGUOUS"
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
function peersPayload(ctx, agent) {
  const rows = peersOf(ctx, agent);
  const text =
    rows.length === 0
      ? "(no other live Sessions in this workspace)"
      : `${rows.length} other live Session(s) in this workspace:\n${rows.map(formatPeer).join("\n")}`;
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

/** Deliver one validated message into one resolved peer row and describe the outcome. */
async function sendToPeer(ctx, createUserMessage, senderId, senderTitle, row, message) {
  const targetAgent = ctx.agents.get(row.id);
  if (targetAgent === undefined) {
    throw new PeerError(`Session "${row.id}" is no longer live`, "PEER_TARGET_GONE");
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
async function deliverPeer(ctx, limiter, createUserMessage, exec, args) {
  const sender = requireAgent(exec, "session_send");
  const senderId = String(sender.id);
  const { message, bytes } = requireMessage(args);
  limiter.admit(senderId);
  const target = resolveTarget(livePeers(ctx, senderId), peersOf(ctx, sender), args.target);
  if (isArchived(ctx, target.id)) {
    throw new PeerError(
      `Session "${target.id}" is archived; its steps are rejected by the host gate, so a message would be dropped unrun. Unarchive it in the GUI first or pick another peer`,
      "PEER_TARGET_ARCHIVED"
    );
  }
  const sent = await sendToPeer(ctx, createUserMessage, senderId, titleOf(ctx, sender.session), target, message);
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

/** Deliver one message to every workspace neighbour and describe each outcome. */
async function broadcastPeers(ctx, limiter, createUserMessage, exec, args) {
  const sender = requireAgent(exec, "session_broadcast");
  const senderId = String(sender.id);
  const { message } = requireMessage(args);
  const targets = peersOf(ctx, sender);
  if (targets.length === 0) {
    return {
      text: "(no other live Sessions in this workspace; nothing was sent)",
      delivered: [],
      failed: []
    };
  }
  limiter.admit(senderId, targets.length);
  const senderTitle = titleOf(ctx, sender.session);
  const delivered = [];
  const failed = [];
  for (const row of targets) {
    try {
      delivered.push(await sendToPeer(ctx, createUserMessage, senderId, senderTitle, row, message));
    } catch (error) {
      failed.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const lines = delivered.map(
    (entry) => `- ${entry.id} | ${entry.mode}${entry.title === "" ? "" : ` | "${entry.title}"`}`
  );
  for (const entry of failed) lines.push(`- ${entry.id} | FAILED | ${entry.error}`);
  return {
    text:
      `Broadcast to ${delivered.length} of ${targets.length} peer(s) in this workspace:\n${lines.join("\n")}` +
      (failed.length === 0 ? "" : `\n${failed.length} delivery failure(s); see the rows above.`),
    delivered,
    failed
  };
}

/** Build both tool definitions against one plugin instance state. */
function defineTools(ctx, resolveCreateUserMessage) {
  const limiter = new RateLimiter();

  const peersTool = {
    name: "session_peers",
    description: PEERS_DESCRIPTION,
    parameters: { type: "object", properties: {}, required: [] },
    output: PEERS_OUTPUT,
    execute(_args, exec) {
      const agent = requireAgent(exec, "session_peers");
      limiter.prune();
      return peersPayload(ctx, agent);
    },
    presentCall() {
      return { card: "generic", title: "List peer sessions", kind: "read", rawInput: "" };
    }
  };

  const sendTool = {
    name: "session_send",
    description:
      SEND_DESCRIPTION +
      ' Target accepts an exact session id from session_peers or an unambiguous part of its title.',
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            'Recipient peer Session as returned by session_peers (exact session id preferred; an unambiguous title fragment also works).'
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
      return deliverPeer(ctx, limiter, createUserMessage, exec, args);
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
      return broadcastPeers(ctx, limiter, createUserMessage, exec, args);
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
