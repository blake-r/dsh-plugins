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
| `session_peers` | List non-archived Sessions accounted to the same workspace from its in-memory index; all rows include exact IDs, live rows include titles, and cold titles are blank. |
| `session_send` | Deliver by exact session ID or exact live-session title; duplicate titles are rejected. Cold targets can be addressed by ID. |
| `session_broadcast` | Deliver one message to every live workspace neighbour; cold Sessions are skipped. |

Discovery and delivery have deliberately different scopes:

- **Discovery and target resolution do not read session files.** `session_peers`
  uses only the in-memory workspace account and live Agents. Cold entries have
  an exact ID but no title; empty drafts may appear because checking blankness
  would require reading their histories. Live subagent children and archived
  Sessions are hidden. Cold child sessions may appear because the workspace
  index does not expose delegation depth.
- **Delivery accepts an exact ID or exact live title.** Title matching is
  case-sensitive, workspace-local, and rejected when more than one live Session
  has the same title. Cold Sessions have no title in the in-memory workspace
  index and can only be addressed by ID. Live IDs can be addressed across
  workspaces; cold IDs must be present in a workspace account. When a cold ID is
  explicitly sent to, DSH restores that one target through its normal resume API.

Delivery semantics mirror subagent steering:

- a cold persisted Session is resumed on its existing session id, composing its recorded agent preset; no new Session is created;
- target `running` -> `agent.steer`, so the message lands at its nearest step boundary;
- target `idle` or newly resumed -> `agent.followup`, so it becomes that Session's next turn and wakes it;
- `session_broadcast` skips cold Sessions. Use an exact ID with `session_send` to wake one.

The delivered message carries the durable source
`{ kind: 'agent-message', form: 'relay', senderSessionId }` — the same
attribution the subagent runtime uses for agent-to-agent content — so the
receiving Session renders it as an agent-triggered turn rather than as input
from its human user. The body names the sender session id and tells the target
how to answer with `session_send`.

## Scope

- Cold persisted Sessions are listed by their workspace-accounted IDs and are
  resumed only when addressed by exact ID. Their titles are intentionally not
  loaded during discovery.
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
  delivery that never happens. If the registry or archive set is unavailable,
  peer operations fail closed with `PEER_ARCHIVE_STATUS_UNAVAILABLE`; they never
  assume the target is unarchived. Unarchive the Session in the GUI to reach it.
- Messages are capped at 32 KiB and rate-limited to 20 per minute per sending
  Session. A broadcast reserves its whole fan-out before sending, so it either
  goes out completely or fails with `PEER_RATE_LIMITED`.

## Composition

The bundle patch inserts one host-plane row. It requires the host
`workspaceRegistry` service so archive checks are authoritative; operations refuse
with `PEER_ARCHIVE_STATUS_UNAVAILABLE` if its state cannot be read.

```yaml
- insert:
    - id: tool-session-peer
      name: '@blake-r/dsh-tool-session-peer'
```

Install it as a profile bundle (`dsh.profile.bundles` + a workspace link in the
profile `package.json`), like the other `@blake-r/*` packages.
