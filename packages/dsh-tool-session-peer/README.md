# @blake-r/dsh-tool-session-peer

Peer messaging between adjacent live Sessions.

Subagents already talk to their parent and children through `send_message`
(`@deepseek-ai/dsh-subagent`), but that runtime enforces direct parent/child
adjacency and exposes no way to address an unrelated Session. Two GUI tabs or
two terminal Sessions had no channel at all.

This plugin adds two model-facing tools:

| Tool | Purpose |
|---|---|
| `session_peers` | List every other live top-level Session: exact session id, title, status (`idle`/`running`), cwd, preset. |
| `session_send` | Deliver one message into another live Session's inbox. |

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
- Only runtime **roots** are listed (`ctx.agents.isOwnedBy(id, undefined)`), so
  another Session's subagent children stay private to it.
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
