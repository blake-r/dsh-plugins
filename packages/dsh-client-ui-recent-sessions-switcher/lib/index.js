// Recent-sessions switcher, node half.
//
// Host side of the ack persistence: durable "last seen" markers for recent
// sessions, keyed by plain <sessionId>, stored in the base storage domain layer
// (unit `recent_sessions_ack`, v1, table `acks`) and exposed to the browser
// half through a small custom Remote service (namespace `recentSessions`,
// methods `getAck` / `ack`). The browser half reaches it via
// `ctx.remote.$mount(...)` (see src/client.js / lib/client.js).
//
// Keys carry no workspace prefix on purpose: session ids are UUIDs (globally
// unique), the storage file is already per-account ($DSH_HOME), and the host's
// process.cwd() is not the workspace of the GUI sessions, so any cwd-derived
// prefix would file the records under a bucket the browser half never reads.
//
// The service follows the base SRC-discovery contract for hand-written
// plugins: a `TypertRemoteService` subclass instantiated in the context, whose
// Remote methods are marked with the typert-protocol method descriptor on the
// prototype (key "@deepseek-ai/dsh-typert-protocol/remote-methods", written by
// the `Remote()` decorator via addMarkerInitializer/mark —
// @deepseek-ai/dsh-typert-protocol/lib/index.js:135, 239-268). The
// dsh-api-gateway discovers it through resolveSrcDescriptor and derives the
// wire contract (parameters by name, `src-json` codecs) from the method
// sources — @deepseek-ai/dsh-api-gateway/lib/index.js:56-127, 1467-1496.
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

// Prototype key holding the Remote-method marker table. The constant is not
// exported by @deepseek-ai/dsh-typert-protocol; keep the literal in sync with
// its lib/index.js:135.
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

// Durable storage unit for the ack table. The unit name matches UNIT_NAME_RE
// (@deepseek-ai/dsh-storage/lib/index.js:80); the base json backend keeps one
// file per unit — $DSH_HOME/storages/recent_sessions_ack.json — with atomic
// whole-file replacement and zod validation from the base layer.
const ackDomainSpec = defineDomain({
  name: "recent_sessions_ack",
  version: 1,
  tables: { acks: domainTable(z.object({ lastSeenAt: z.number() })) }
});

class RecentSessionsAckService extends TypertRemoteService {
  constructor(ctx, domain) {
    super(ctx, "recentSessions");
    this.domain = domain;
  }

  // Remote: recentSessions/getAck -> { [sessionId]: lastSeenAt } for every
  // marker this account has. Missing entries mean "read" on the client.
  async getAck() {
    const entries = {};
    for (const [sessionId, value] of this.domain.table("acks").entries()) {
      if (sessionId.length > 0) entries[sessionId] = value.lastSeenAt;
    }
    return entries;
  }

  // Remote: recentSessions/ack(sessionId, lastSeenAt) — upsert one marker.
  async ack(sessionId, lastSeenAt) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("ack: sessionId must be a non-empty string");
    if (typeof lastSeenAt !== "number" || !Number.isFinite(lastSeenAt) || lastSeenAt < 0) throw new TypeError("ack: lastSeenAt must be a non-negative finite number");
    await this.domain.table("acks").put(sessionId, { lastSeenAt });
    return { ok: true };
  }
}

// Hand-written equivalent of the `Remote()` decorator output: a frozen v1
// method marker table on the prototype, exactly as addMarkerInitializer/mark
// produce (dsh-typert-protocol/lib/index.js:252-268). Both methods use a plain
// "direct" invocation; parameters are derived by the gateway from the method
// sources (json, src-json codec).
Object.defineProperty(RecentSessionsAckService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: "getAck", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "ack", invocation: Object.freeze({ kind: "direct" }) })
    ])
  })
});

// The base storage-domain row provides the domain facility both as the
// hub-mounted form `ctx.storage.domain` and as the service `storageDomain`
// (dsh-storage-domain/lib/index.js:180-194); `storageDomain` is what
// dsh-workspace injects for the same purpose.
export const inject = ["storageDomain"];

/** Host plugin body: open the ack domain unit and publish the Remote service. */
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(ackDomainSpec);
  ctx.effect(() => () => domain.close());
  new RecentSessionsAckService(ctx, domain);
}
