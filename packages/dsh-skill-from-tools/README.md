# @blake-r/dsh-skill-from-tools

One skill per tool (no module grouping), short form with a compact parameter schema.

## Install

From npm (published):

```bash
dsh plugin --profile web add @blake-r/dsh-skill-from-tools
```

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-skill-from-tools
```

## What it does

A bundle package in the dsh-plugins monorepo. See the header comment in
`src/dsh-skill-from-tools.mjs` for full behavior.

Each skill's catalog `description` renders its tool's parameter schema as a
**compact literal** in which every field's type is enclosed in `/`:

- required field: `"command":/string/`
- optional field: `"description":/undef|string/` (`undef` = may be absent)
- const field: `"kind":/"new"/` — no `undef|` prefix, even when not required
- enum: `"action":/"edit"|"pause|resume"/` — literal values stay double-quoted
  and can never collide with the `/` marker
- nested objects/arrays expand recursively: `"options":/undef|[{"label":/string/}]/`,
  `"questions":/{"id":/string/,"header":/undef|string/}/`
- `oneOf` unions: `/"new"|string/` (literal beside a type), `"cursor":/string|null/`
  (nullable) or `{"kind":/"a"/}|{"kind":/"b"/}` (discriminated)

Every field carries the marker — including one whose type is a whole container —
so no bare type name is ever left unmarked. `null` is a valid value, distinct
from `undef` absence, and is never folded into `undef`. A `type` array
(`type: ["string","null"]`), which reaches the plugin only through a raw MCP
`inputSchema`, renders as the union of its names, with an `array` branch expanded
through `items`. `json`/empty schemas collapse to `any`.

Each skill's `content` block carries the tool's parameters as **minified JSON
Schema**, dumped verbatim from the registry, under an explicit
`Arguments (JSON Schema):` label so the parameter block is distinguishable from
the prose guidance above it:

```
## `bash` tool
Invoke directly as a tool_call named `bash`.
<full tool description>
<tool:<name> prose guidance from the assembly>
Arguments (JSON Schema): {"type":"object","properties":{"command":{"type":"string",...
```

The label is omitted only for tools that take no parameters (the catalog
`description` still reports `Arguments: {}` for them).

Each skill explicitly states that its tool is invoked as a **direct `tool_call`**
with its own name — **not** routed through the `mcp` gateway — so the model does
not confuse the skill's tool with an MCP tool.
