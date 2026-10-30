# @blake-r/dsh-command-status-interrupt

DSH host plugin: a `/status` command that aborts the running generation and
asks the model for a progress report WITHOUT opening a new turn and WITHOUT a
user bubble.

Mechanism:
1. While the agent is running, the command injects a system-role message
   (`source.kind === "system"`) into the agent's next-step inbox and then
   cancels the current generation (`keepInbox: true`). `inject` does not wake
   the driver, so the message is queued before the abort is seen.
2. The agent-loop patch makes `turn()` resume the SAME turn after an abort when
   next-step messages are pending: it resets the AbortController and continues
   the loop, so the status report is produced in the turn that was interrupted.
   The turn counter does not change (unlike `followup`, which opens a new turn).
3. The same patch routes `source.kind === "system"` messages to `system/message`
   events instead of `user/message`, so the status prompt is not a user bubble.

When the agent is idle the command falls back to `steer` (a normal new turn
with the prompt as a system node).

## Config shape

```yaml
- id: dsh-command-status-interrupt
  name: '@blake-r/dsh-command-status-interrupt'
  config:
    prompt: <the status prompt text sent to the model>
    hint: <composer placeholder shown after picking the command, optional>
```

## Install

```bash
dsh plugin --profile web add @blake-r/dsh-command-status-interrupt
```

The plugin is host-only: reference it by name in the profile's
`cordis.patch.yml` (a plain row, no `insert`).