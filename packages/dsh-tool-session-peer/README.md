# @blake-r/dsh-tool-session-peer

Peer messaging between adjacent live Sessions.

Requires DSH **0.2.2-rc.2 or newer**. Since 0.2.2 the `ctx.agents` registry no
longer offers an ownership predicate and hands out bare `{ id }` handles, so
root detection reads `delegationDepth` from the session header instead (see
[Scope](#scope)). The header field also exists in 0.2.1-rc.5, so this version
runs on both.

Subagents already talk to their parent and children through `send_message`
(`@deepseek-ai/dsh-subagent`), but that runtime enforces direct parent/child
adjacency and exposes no way to address an unrelated Session. Two GUI tabs or
two terminal Sessions had no channel at all.

This plugin adds two model-facing tools:

| Tool | Purpose |
|---|---|
| `session_peers` | List the neighbouring live Sessions — those working in the same workspace directory — with exact session id, title, status (`idle`/`running`), cwd, preset. |
| `session_send` | Deliver one message into another live Session's inbox. |

Discovery and delivery have deliberately different scopes:

- **Discovery is workspace-local.** `session_peers` shows only top-level
  Sessions whose `cwd` equals the caller's, so an agent learns about the tabs it
  shares a checkout with, not about every tab in the process.
- **Delivery is process-wide.** `session_send` resolves any exact live session
  id, including one in another workspace. That reach is not advertised in either
  tool description: it exists for Sessions introduced out of band (a message
  received, a note from the user), not as a browsing surface.

Delivery semantics mirror subagent steering:

- target `running` -> `agent.steer`, so the message lands at its nearest step boundary;
- target `idle` -> `agent.followup`, so it becomes that Session's next turn and wakes it.

The delivered message carries the durable source
`{ kind: 'agent-message', form: 'relay', senderSessionId }` — the same
attribution the subagent runtime uses for agent-to-agent content — so the
receiving Session renders it as an agent-triggered turn rather than as input
from its human user. The body names the sender session id and tells the target
how to answer with `session_send`.

## Scope

- Only **live** Sessions are addressable. A cold (persisted but not running)
  Session is not resumed: waking someone else's tab from disk would mount its
  preset behind its owner's back.
- Only runtime **roots** are listed, so another Session's subagent children stay
  private to it. Root-ness comes from the persisted session header: an Agent
  whose header reports a non-zero `delegationDepth` is a subagent child and is
  dropped; an absent or zero depth means top-level.
- `session_peers` is scoped to the caller's `cwd`; a caller with no known
  workspace cannot be scoped and sees every live root.
- Messages are capped at 32 KiB and rate-limited to 20 per minute per sending
  Session.

## Composition

The bundle patch inserts one host-plane row:

```yaml
- insert:
    - id: tool-session-peer
      name: '@blake-r/dsh-tool-session-peer'
```

Install it as a profile bundle (`dsh.profile.bundles` + a workspace link in the
profile `package.json`), like the other `@blake-r/*` packages.
