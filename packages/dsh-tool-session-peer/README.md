# @blake-r/dsh-tool-session-peer

Peer messaging between adjacent live and persisted Sessions.

Requires DSH **0.2.2-rc.2 or newer**. Since 0.2.2 the `ctx.agents` registry no
longer offers an ownership predicate and hands out bare `{ id }` handles, so
root detection reads `delegationDepth` from the session header instead (see
[Scope](#scope)). The header field also exists in 0.2.1-rc.5, so this version
runs on both.

Subagents already talk to their parent and children through `send_message`
(`@deepseek-ai/dsh-subagent`), but that runtime enforces direct parent/child
adjacency and exposes no way to address an unrelated Session. Two GUI tabs or
two terminal Sessions had no channel at all.

This plugin adds three model-facing tools:

| Tool | Purpose |
|---|---|
| `session_peers` | List non-archived Sessions accounted to the same workspace, live or cold, after their first user message; empty UI drafts are hidden. |
| `session_send` | Deliver one message by exact session id or exact title; resume a cold persisted target only when explicitly addressed. |
| `session_broadcast` | Deliver one message to every live workspace neighbour; cold Sessions are skipped. |

Discovery and delivery have deliberately different scopes:

- **Discovery is workspace-local.** `session_peers` shows non-archived root
  Sessions whose `cwd` equals the caller's and whose ids are accounted to a
  workspace. It includes cold persisted Sessions with conversation history so
  restart does not make an active tab disappear from addressing, but excludes
  blank UI drafts that have not received a `user/message` event.
- **Delivery by id is process-wide.** An exact session id resolves across
  workspaces; an exact title resolves only among the caller's listed peers.
  Substrings and approximate matches are never used.

Delivery semantics mirror subagent steering:

- a cold persisted Session is resumed on its existing session id, composing its recorded agent preset; no new Session is created;
- target `running` -> `agent.steer`, so the message lands at its nearest step boundary;
- target `idle` or newly resumed -> `agent.followup`, so it becomes that Session's next turn and wakes it;
- `session_broadcast` skips cold Sessions. Use an exact id or title with `session_send` to wake one.

The delivered message carries the durable source
`{ kind: 'agent-message', form: 'relay', senderSessionId }` — the same
attribution the subagent runtime uses for agent-to-agent content — so the
receiving Session renders it as an agent-triggered turn rather than as input
from its human user. The body names the sender session id and tells the target
how to answer with `session_send`.

## Scope

- Cold persisted Sessions are discoverable only when they remain in a
  workspace's session account and are not archived. They are resumed only on an
  exact `session_send` address, using the existing id and recorded preset. A
  title must exactly match; duplicate titles are ambiguous and require the id.
- Only runtime **roots** are listed, so another Session's subagent children stay
  private to it. Root-ness comes from the persisted session header: an Agent
  whose header reports a non-zero `delegationDepth` is a subagent child and is
  dropped; an absent or zero depth means top-level.
- `session_peers` is scoped to the caller's `cwd`; a caller with no known
  workspace cannot be scoped and sees every accounted non-archived root.
- **Archived Sessions are excluded.** An archived Session can still have a
  live, idle Agent, but the archive set hides it from every grouping surface
  and the host `agent/pre-step` gate rejects its steps: a followup there would
  claim the message, run a turn nobody can see, and drop the input unrun.
  `session_peers` therefore omits archived Sessions, and `session_send` refuses
  an archived target with `PEER_TARGET_ARCHIVED` instead of reporting a
  delivery that never happens. Unarchive the Session in the GUI to reach it.
- Messages are capped at 32 KiB and rate-limited to 20 per minute per sending
  Session. A broadcast reserves its whole fan-out before sending, so it either
  goes out completely or fails with `PEER_RATE_LIMITED`.

## Composition

The bundle patch inserts one host-plane row:

```yaml
- insert:
    - id: tool-session-peer
      name: '@blake-r/dsh-tool-session-peer'
```

Install it as a profile bundle (`dsh.profile.bundles` + a workspace link in the
profile `package.json`), like the other `@blake-r/*` packages.
