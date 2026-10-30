# @blake-r/dsh-skill-from-tools

Every non-`skill` tool stays directly invocable in the LLM request's `tools`
array, and ALSO becomes a skill that holds the tool's full details as an
on-demand detail layer.

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

### Tools zone

Each tool in the LLM request's `tools` array keeps a SHORT form:

- `description` — the first sentence of the original description.
- `parameters` — a MINIMAL JSON Schema: a real object (the LLM tool-call layer
  consumes `parameters` as JSON Schema, so a compact string would break argument
  generation). Every annotation is stripped recursively — `description`,
  `title`, `examples`, `default`, `$comment`, `enumDescriptions` — while all
  structure is kept: `type`, `required`, `enum`/`const` VALUES, `items`,
  `properties`, `$ref`, `oneOf`/`anyOf`. The enum/const values are never
  dropped, only the prose around them:

  ```json
  "action": { "type": "string", "enum": ["edit", "pause", "resume"] }
  ```

### Skills

One skill per tool (except `skill` itself) carries the full detail layer. The
catalog `description` is a bare comment — `Tool details for \`X\`.` — with no
schema, so the catalog stays tiny. The skill `content` block carries the FULL
description, the `tool:<name>` prose guidance from the assembly, and the
VERBATIM (fully annotated) JSON Schema under an explicit
`Arguments (JSON Schema):` label:

```
## `bash` tool
Full details for the `bash` tool; invoke it directly as a tool_call.
<full tool description>
<tool:<name> prose guidance from the assembly>
Arguments (JSON Schema): {"type":"object","properties":{"command":{"type":"string",...
```

The label is omitted only for tools that take no parameters. `whenToUse` signals
the skill is a DETAIL reference, not an invocation path — the tool is invoked
directly as a `tool_call` with its own name.
