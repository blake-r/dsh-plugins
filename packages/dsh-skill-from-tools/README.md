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
**compact literal**. The `/.../` marker delimits one type atom — a type name,
`undef`, a double-quoted literal, or a reference — and the operators `|` and `&`
stand only *between* markers:

- required field: `"command":/string/`
- optional field: `"description":/undef/|/string/` (`undef` = may be absent, an
  ordinary alternative)
- const field: `"kind":/"new"/` — no `undef` alternative, even when not required
- enum: `"action":/"edit"/|/"pause"/|/"resume"/` — one marked literal per value, so
  a value containing `|` or `&` can never be confused with an operator. The literal
  is a JSON string literal, so an embedded double quote is escaped
  (`/"say \"hi\""/`) instead of breaking the notation
- containers are self-delimiting and stand as whole alternatives:
  `"options":[{"label":/string/}]`, `"daily":/undef/|{"time":/string/,"time_zone":/string/}`
- `oneOf`/`anyOf` unions: `"cursor":/undef/|/string/|/null/` (nullable),
  `{"kind":/"a"/}|{"kind":/"b"/}` (discriminated)
- `$ref`: `/$ref:Thing/` — the last token of the pointer, exactly as written; the
  pointer is never followed, so a cyclic schema cannot recurse
- a `$ref` beside a structural keyword is a conjunction: `/object/&/$ref:Node/`
  (`&` binds tighter than `|`; parentheses regroup as `(/A/|/B/)&(/C/|/D/)`)

`null` is a valid value, distinct from `undef` absence, and is never folded into
`undef`. `json` marks a node that declares no type this renderer can read (an empty
schema, annotations only, an unknown keyword) — the harness's own keyword for the
same node is `type: "json"`. The empty pointer (`"#"`, the document root) renders as
`/$ref:root/`, a trailing slash as `/$ref:/`, and a target in another document as
`/json/`. A `type` array (`type: ["string","null"]`), which reaches the plugin only
through a raw MCP `inputSchema`, renders as the union of its names, with an `array`
branch expanded through `items`: `/string/|[/string/]`.

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
