# @blake-r/dsh-tool-node

DSH tools: `node_run` — execute an existing Node.js script file — and
`node_npm` — install packages with npm into the workspace node-env.

Node subprocesses are confined through the same DSH sandbox seam the bash tool
uses: `ctx.sandbox.confine` wraps the exact argv under the resolved per-call
policy (on macOS this selects Apple's sandbox-exec / Seatbelt), and
`ctx.sandboxPolicy` + `ctx.approval` drive the same-turn escalation flow. When
no sandbox backend is usable the call fails closed (`SandboxUnavailableError`)
— the command never runs unconfined.

## Mounting contract

Mounted via `cordis:include` of `shared/cordis.patch.yml` (preset plane). Any
preset that should get these tools must `cordis:include` the shared patch — the
same contract as `@blake-r/dsh-tool-python`. A preset created from scratch
without the include silently gets none of these tools.

## Install

```bash
dsh plugin --profile web add @blake-r/dsh-tool-node
```

The plugin is host-only: reference it by name in the shared
`cordis.patch.yml` (a plain row, no `insert`).