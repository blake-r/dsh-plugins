# @blake-r/dsh-skill-from-tools

One skill per tool (no module grouping), short form.

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

Each skill explicitly states that its tool is invoked as a **direct `tool_call`**
with its own name — **not** routed through the `mcp` gateway — so the model does
not confuse the skill's tool with an MCP tool.
