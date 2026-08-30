# @blake-r/dsh-assembly-rewrite

Rewrite named system-prompt assembly inserts (tools, sections, contexts,
variables) from config.

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

A generic, config-driven plugin for the web profile. It reads a map of
overrides from this row's `config` and, in the `system-prompt/assemble`
waterfall, rewrites any named insert whose name appears in the config — across
all four assembly namespaces: `tools`, `sections`, `contexts`, and `variables`.
No code changes are needed to add or tweak an override.

Config shape (see the profile's `cordis.patch.yml`):

```yaml
config:
  tools:
    <toolName>:
      description: <replacement tool description>
      parameters:
        <paramName>:
          description: <replacement parameter description>
  sections:
    <sectionName>:
      text: <replacement section text>
  contexts:
    <contextName>:
      text: <replacement context text>
  variables:
    <variableName>: <replacement string value>
```

A config key addresses an insert only within its own namespace, so names may
collide across namespaces without conflict. The listener runs first in the
waterfall (`prepend: true`), so rewritten tool descriptions are captured into
skill bodies by `dsh-skill-from-tools`.

See the header comment in `src/dsh-assembly-rewrite.mjs` for full behavior.