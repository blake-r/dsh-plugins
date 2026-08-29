# @blake-r/dsh-skill-from-tools

One skill per tool (no module grouping), short form with a compact JSON schema.

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

Each skill renders its tool's parameter schema as a **compact JSON literal**
instead of `Requires ...` / `Optionally ...` prose:

- required field: `"command":string`
- optional field: `"command":undef|string` (`undef` = may be absent)
- nested objects/arrays expand recursively: `{"questions":[{"id":string,...}]}`
- enums: `"edit"|"pause"|"resume"|"complete"|"blocked"`
- `oneOf` unions: `integer|null` (nullable) or `{...}|{...}` (discriminated)

`null` is a valid value (distinct from `undef` absence); `json`/empty schemas
collapse to `any`. This is the most compact of the considered formats (~0.45x
of the previous prose form) with no tool growing in size.

Each skill explicitly states that its tool is invoked as a **direct `tool_call`**
with its own name — **not** routed through the `mcp` gateway — so the model does
not confuse the skill's tool with an MCP tool.
