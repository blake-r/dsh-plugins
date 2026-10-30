# dsh-spill-policy

Replacement spill policy for DeepSeek Harness (dsh).

## What it does

Bounds the model-facing result of oversized tool calls: instead of the full
output, the model sees a minimal preview — the first `headLines` non-empty
lines and the last `tailLines` non-empty line(s), each capped at `lineCap`
bytes — plus a single header line pointing at the full output. The full output
is **not written to a file**: it is committed to the durable session log as a
`plugin:spill` sibling record (an `ignorable` plugin record that never enters
the model-visible surface), and the header cites the sibling's seq. The model
reads the full output back via the `recall` tool (seq pointer) when it actually
needs the data.

Divergence from base `@deepseek-ai/dsh-spill-policy`:

- Byte cap (`maxInlineBytes` — the deployment's row config sets 131072,
  matching the read tool's `readMaxBytes`; the code default is 4096 vs the
  base 50000).
- **Log-based spill.** The full output is a `plugin:spill` sibling record in
  the session log, not a spill-store file. The spill-store dependency is gone;
  the record survives compaction and fork/resume (the durable log is never
  mutated), and `recall`/`search` in `dsh-tool-trajectory-recall` restore and
  page it.
- Structured results (JSON/JSONL/CSV/TSV/XML/HTML/YAML) get a first-level
  structural summary folded into the stats line; the record is saved verbatim,
  never reformatted.
- `excludeTools` (default `["read", "skill", "recall"]`) keeps those results
  inline in full. `read` avoids a read -> spill -> read loop; `skill` results
  are instructions the model needs verbatim; `recall` is excluded so an
  un-paged recall of a big spilled sibling does not cascade into a fresh spill.
- The preview is a MINIMAL sample, not a budget-filling head/tail slice. A
  capped line gains a "… [truncated N bytes]" suffix; skipped middle lines are
  summarized by a "[truncated N lines]" marker. A single header line —
  "[Spilled to seq N] Read it back with the recall tool (recall type=\"seq\"
  id=\"N\"), never with read or bash (the content is in the session log, not a
  file). [Below is the truncated version] [<stats>]" — sits at the top and
  doubles as the head/tail separator. The recall instruction is part of the
  header, so the model always knows how to read the spilled content back.
- `lineCap` is derived from `maxInlineBytes` minus a worst-case overhead, so
  the replacement never exceeds `maxInlineBytes` by construction.

There is no Arm 2 (`tools/ptc-dispatch-log`): `tool/ptc-dispatch` is not
surface-eligible and never reaches the model window, so spilling it would only
duplicate the durable-log copy invisibly — its oversized content stays inline
in the ptc-dispatch record.

## Preview layout

For an oversized result the replacement reads (top to bottom):

```
[Spilled to seq 42] Read it back with the recall tool (recall type="seq" id="42"), never with read or bash (the content is in the session log, not a file). [Below is the truncated version] [JSONL · 112788 bytes · 5000 lines · 5000 records · first-record keys: a, b]
{"a": 1, "b": 2}
{"a": 2, "b": 3}
[truncated 4997 lines]
{"a": 5000, "b": 5001}
```

A single line longer than `lineCap` is capped with an ellipsis and a byte count:

```
[Spilled to seq 43] Read it back with the recall tool (recall type="seq" id="43"), never with read or bash (the content is in the session log, not a file). [Below is the truncated version] [JSON object · 4029 bytes · 1 line · keys: a, b, c]
{"a":1,"b":2,"c":[0,1,2,...,348,… [truncated 2725 bytes]
```

Plain-text results carry no summary in the stats line: `[Spilled to seq N] Read
it back with the recall tool (recall type="seq" id="N"), never with read or
bash (the content is in the session log, not a file). [Below is the truncated
version] [txt · N bytes · M lines]`. Whitespace in the structural summary is
collapsed to single spaces, so the header always stays on one line even when
JSON keys or CSV headers contain newlines.

## Mount

The bundle patch disables the base `spill-policy` row and inserts
`dsh-spill-policy`. The row's config overrides `maxInlineBytes` to 131072
bytes (32K tokens), while the remaining defaults live in the plugin code
(`headLines: 2`, `tailLines: 1`, `excludeTools: ["read", "skill", "recall"]`)
and apply whenever no config is specified. A profile patch applied after this
bundle layer can still override the values:

```yaml
- id: spill-policy-replacement
  config:
    maxInlineBytes: 131072
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