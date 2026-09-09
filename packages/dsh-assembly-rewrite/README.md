# @blake-r/dsh-assembly-rewrite

Rewrite exactly one named system-prompt assembly insert (tool, section,
context, variable) from config.

## Install

From npm (published):

```bash
dsh plugin --profile web add @blake-r/dsh-assembly-rewrite
```

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-assembly-rewrite
```

## What it does

Each plugin row patches exactly ONE assembly value: the insert addressed by
the `(namespace, name)` pair in that row's `config`. To rewrite several
values, add several rows with distinct ids, each with its own config. No code
changes are needed to add or tweak an override.

Config shape (see the profile's `shared.cordis.yml`):

```yaml
config:
  namespace: tools | sections | contexts | variables
  name: <insert name>
  # namespace-specific payload:
  #   tools:     description, parameters.<param>.description
  #   sections:  text, before?, after?
  #   contexts:  text
  #   variables: value
```

Example — rewrite the `exit_plan_mode` tool:

```yaml
- id: dsh-assembly-rewrite-exit-plan-mode
  name: '@blake-r/dsh-assembly-rewrite'
  config:
    namespace: tools
    name: exit_plan_mode
    description: <replacement tool description>
    parameters:
      plan:
        description: <replacement parameter description>
```

Example — insert the `identity` section after the persona:

```yaml
- id: dsh-assembly-rewrite-identity
  name: '@blake-r/dsh-assembly-rewrite'
  config:
    namespace: sections
    name: identity
    after: deployment:persona
    text: <replacement section text>
```

A configured insert that is not present in the assembled prompt is silently
skipped. Sections: an existing section is overwritten in place and never
duplicated; a missing one is inserted before/after the named anchor via
`before`/`after`, or appended at the end when no anchor is given (or the
anchor is missing). `before` wins over `after`.

The listener runs first in the waterfall (`prepend: true`), so rewritten tool
descriptions are captured into skill bodies by `dsh-skill-from-tools`.

See the header comment in `src/dsh-assembly-rewrite.mjs` for full behavior.