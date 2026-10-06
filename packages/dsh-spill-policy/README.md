# dsh-spill-policy

Replacement spill policy for DeepSeek Harness (dsh).

## What it does

Bounds the model-facing result of oversized tool calls: instead of the full
output, the model sees a minimal preview — the first `headLines` non-empty
lines and the last `tailLines` non-empty line(s), each capped at `lineCap`
bytes — plus a single header line pointing at the full artifact in the spill
store (`ctx.spillStore`, `@deepseek-ai/dsh-spill-local`). The model reads the
artifact back via `read` when it actually needs the data.

Divergence from base `@deepseek-ai/dsh-spill-policy`:

- Much tighter byte cap (`maxInlineBytes`, default 4096 vs the base 50000).
- Structured results (JSON/JSONL/CSV/TSV/XML/HTML/YAML) get a first-level
  structural summary folded into the stats line; the artifact is saved
  verbatim, never reformatted.
- `excludeTools` (default `["read", "skill"]`) keeps those results inline in
  full.
- The preview is a MINIMAL sample, not a budget-filling head/tail slice. A
  capped line gains a "… [truncated N bytes]" suffix; skipped middle lines are
  summarized by a "[truncated N lines]" marker. A single header line —
  "[Result is too long and should be read from <locator>] Read it with the read
  tool, never with bash (a bash read re-triggers the spill formation). [Below is
  the truncated version] [<stats>]" — sits at the
  top and doubles as the head/tail separator. The read instruction is part of
  the header, so the model always knows how to read the spill-file back.
- `lineCap` is derived from `maxInlineBytes` minus a worst-case overhead, so
  the replacement never exceeds `maxInlineBytes` by construction.

## Preview layout

For an oversized result the replacement reads (top to bottom):

```
[Result is too long and should be read from spill/xxx.jsonl] Read it with the read tool, never with bash (a bash read re-triggers the spill formation). [Below is the truncated version] [JSONL · 112788 bytes · 5000 lines · 5000 records · first-record keys: a, b]
{"a": 1, "b": 2}
{"a": 2, "b": 3}
[truncated 4997 lines]
{"a": 5000, "b": 5001}
```

A single line longer than `lineCap` is capped with an ellipsis and a byte count:

```
[Result is too long and should be read from spill/data.json] Read it with the read tool, never with bash (a bash read re-triggers the spill formation). [Below is the truncated version] [JSON object · 4029 bytes · 1 line · keys: a, b, c]
{"a":1,"b":2,"c":[0,1,2,...,348,… [truncated 2725 bytes]
```

Plain-text results carry no summary in the stats line: `[Result is too long and should be read from <locator>] Read it with the read tool, never with bash (a bash read re-triggers the spill formation). [Below is the truncated version] [txt · N bytes · M lines]`. Whitespace in the structural summary is collapsed
to single spaces, so the header always stays on one line even when JSON keys or
CSV headers contain newlines.

## Mount

The bundle patch disables the base `spill-policy` row and inserts
`dsh-spill-policy`. The row carries no config: the defaults live in the
plugin code (`maxInlineBytes: 4096`, `headLines: 2`, `tailLines: 1`,
`excludeTools: ["read", "skill"]`) and apply whenever no config is specified.
A profile patch applied after this bundle layer can still override the values:

```yaml
- id: dsh-spill-policy
  config:
    maxInlineBytes: 8192
    headLines: 3
    tailLines: 2
```

`headLines` and `tailLines` must be non-negative integers with
`headLines + tailLines >= 1`.

Plus the `link:` dependency in `home/profiles/web/package.json` and the entry
in `dsh.profile.bundles`.

## Test

```sh
node --check src/dsh-spill-policy.mjs
```
