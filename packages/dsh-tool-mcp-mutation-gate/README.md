# @blake-r/dsh-tool-mcp-mutation-gate

DSH host plugin: an MCP command filter that asks the user for confirmation
before executing a server's mutating tools. A tool name is matched against the
heuristic list (plain words anchored at letter/digit boundaries, or `/regex/`
entries used verbatim); a match routes the call through the harness approval
seam with a `— mutating operation, confirmation required` reason. The granted
confirmation is remembered for an hour.

The default heuristics cover the mutating verbs a tool name commonly starts
with: `create`, `update`, `delete`, `set`, `add`, `remove`, `move`, `send`,
`post`, `comment`, `reply`, `clear`, `upload`, `manage`, `insert`, `import`,
`replace`, `modify`, `copy`, `append`, `prepend`. `import` is included so
`import_to_google_slides` / `import_to_google_sheets` / `import_to_google_doc`
(and similar import tools) are gated.

## Config shape

```yaml
- id: mutation-gate-google
  name: '@blake-r/dsh-tool-mcp-mutation-gate'
  config:
    server: google
    # heuristics?: [<word|/regex/>, ...]   # default DEFAULT_HEURISTICS
```

`server` selects which MCP server's tools the filter applies to. The plugin is
host-only: reference it by name in a preset's `agent.cordis.yml` (a plain row,
no `insert`).

## Install

```bash
dsh plugin --profile web add @blake-r/dsh-tool-mcp-mutation-gate
```