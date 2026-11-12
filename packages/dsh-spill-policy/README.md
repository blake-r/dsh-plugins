# dsh-spill-policy

Replacement spill policy for DeepSeek Harness (dsh).

## What it does

Bounds the model-facing result of oversized tool calls: instead of the full
output, the model sees a minimal preview — the first `headLines` non-empty
lines and the last `tailLines` non-empty line(s), each capped at `lineCap`
bytes — plus a single header line pointing at the full output. The full output
is **written to a file** inside the owning session's own directory
(`<sessionDir>/spill/<timestamp>-<tool>-<call>.<ext>`), next to
`session.jsonl.zstd`, where it stays permanently. The model reads it back with
the `read` tool (paging via offset/limit) or parses it with bash and any script
(`jq`, `python3`, `grep`) — it is an ordinary file on disk.

There is **no log-record fallback**: nothing is appended to the session log. If
the persistence backend is missing, cannot locate the session, or the write
fails, the result stays inline in full and a warning is logged — a spill failure
never turns a successful call into an error or hides content.

Divergence from base `@deepseek-ai/dsh-spill-policy`:

- Byte cap (`maxInlineBytes` — the deployment's row config sets 16384, the
  "4K tokens" budget under the token-meter heuristic density of 4 chars/token;
  the code default is 4096 bytes vs the base 50000).
- **File-based spill.** The artifact lands in `<sessionDir>/spill/`, whose path
  comes from the persistence backend itself
  (`ctx.get("sessionPersistence").locate(session.header)`), so nothing hardcodes
  `$DSH_HOME` and any root/project-key layout works.
- Structured results (JSON/JSONL/CSV/TSV/XML/HTML/YAML) get a first-level
  structural summary folded into the stats line, and the artifact extension
  follows the detected kind; the file is saved verbatim, never reformatted.
- `excludeTools` (default `["read", "skill", "recall"]`) keeps those results
  inline in full. `read` avoids a read -> spill -> read loop; `skill` results
  are instructions the model needs verbatim; `recall` is excluded so an un-paged
  recall of a big record does not cascade.
- The preview is a MINIMAL sample, not a budget-filling head/tail slice. A
  capped line gains a "… [truncated N bytes]" suffix; skipped middle lines are
  summarized by a "[truncated N lines]" marker. A single header line —
  "[Spilled to <path>] Full output on disk - read or parse that file. Truncated
  preview below. [<stats>]" — sits at the top and doubles as the head/tail
  separator.
- `lineCap` is derived from `maxInlineBytes` minus a worst-case overhead, so
  the replacement never exceeds `maxInlineBytes` by construction.

There is no Arm 2 (`tools/ptc-dispatch-log`): `tool/ptc-dispatch` is not
surface-eligible and never reaches the model window.

## Preview layout

For an oversized result the replacement reads (top to bottom):

```
[Spilled to /…/sessions/…/session-abc/spill/20261112134653818-bash-call_1.jsonl] Full output on disk - read or parse that file. Truncated preview below. [JSONL · 97782 bytes · 5000 lines · 5000 records · first-record keys: a, b]
{"a":0,"b":1}
{"a":1,"b":2}
[truncated 4997 lines]
{"a":4999,"b":5000}
```

A single line longer than `lineCap` is capped with an ellipsis and a byte count:

```
[Spilled to …/spill/20261112134653818-bash-call_2.json] Full output on disk - read or parse that file. Truncated preview below. [JSON object · 4029 bytes · 1 line · keys: a, b, c]
{"a":1,"b":2,"c":[0,1,2,...,348,… [truncated 2725 bytes]
```

Plain-text results carry no summary in the stats line: `[txt · N bytes · M
lines]`. Whitespace in the structural summary is collapsed to single spaces, so
the header always stays on one line even when JSON keys or CSV headers contain
newlines.

## Mount

The bundle patch disables the base `spill-policy` row and inserts
`dsh-spill-policy`. The row's config overrides `maxInlineBytes` to 16384 bytes
(4K tokens at the token-meter heuristic density of 4 chars/token), while the
remaining defaults live in the plugin code (`headLines: 2`, `tailLines: 1`,
`excludeTools: ["read", "skill", "recall"]`) and apply whenever no config is
specified. A profile patch applied after this bundle layer can still override
the values:

```yaml
- id: spill-policy-replacement
  config:
    maxInlineBytes: 16384
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
