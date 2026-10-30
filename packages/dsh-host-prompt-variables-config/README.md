# @blake-r/dsh-host-prompt-variables-config

DSH host plugin: registers extra prompt variables so they can be referenced as
`{{name}}` in any system-prompt section (identity, contexts, tool schemas).

Out of the box the agent loop registers only `{{provider}}`, `{{model}}`, and
`{{cwd}}`. This plugin lets you add more via config:

```yaml
- id: prompt-variables
  name: '@blake-r/dsh-host-prompt-variables-config'
  config:
    variables:
      session_id: agent.session.header.id
      workspace:  agent.session.header.cwd
```

Each value is a dot-path resolved against the assembly context
`{ agent, scope, signal }` (like Python's attrgetter): split on `.`, walk the
keys; a missing key yields `undefined` and is logged as a warning via
`ctx.logger.warn`.

Variable names must match `/^[a-z][a-z0-9_]*$/` (lowercase only), hence
`session_id` not `sessionId`.

Mechanism: `ctx.systemPrompt.variable(name, provider)` — the same API the agent
loop uses for the built-in variables. `systemPrompt` is a Cordis service, so it
must be listed in `inject` for `ctx.systemPrompt` to resolve (declared in the
module; the config row need not repeat it).

## Install

```bash
dsh plugin --profile web add @blake-r/dsh-host-prompt-variables-config
```

The plugin is host-only: reference it by name in the profile's
`cordis.patch.yml` (a plain row, no `insert`).