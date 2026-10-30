# @blake-r/dsh-im-multiagent

One Telegram chat, all active Harness sessions. The plugin auto-discovers
active sessions (host events), mirrors their messages into the chat and
routes replies back by `reply_to_message`. The user never operates on
`sessionId` and binds nothing manually.

Design: `.dsh/plans/dsh-im-multiagent-architecture.md` (workspace repo).

## Status

Under construction. The package skeleton and the vendored Telegram layer
(stage 1 of the plan) are in place; the row in `cordis.patch.yml` is
**disabled** so the plugin cannot steal Telegram `getUpdates` from the live
`xmanrui-dsh-im` bot.

## Layout

```
plugin-src/host/   — host plugin entry and the new multiagent modules
                     (SessionMirror, InboundRouter, MessageIndex, BotChannel,
                     InteractionAdapter, MenuBuilder, CmdSkillPicker,
                     StateStore, Management RPC)
src/channels/      — vendored dsh-im Telegram layer (telegram/, shared/),
                     unmodified upstream copy (dsh-im 4.17.1)
```

## Vendoring

`src/channels/` is a verbatim copy of `@xmanrui/dsh-im@4.17.1`
`src/channels/{telegram,shared}/`. It is self-contained (node builtins +
`undici` only). Do not edit vendored files; adapt by wrapping or by a
pointwise, clearly marked patch when the plan requires it.

## Install

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-im-multiagent
```

The row mounts disabled; enable it in the deployment profile patch by
deleting the `disabled: true` line.