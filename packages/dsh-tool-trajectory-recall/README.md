# @blake-r/dsh-tool-trajectory-recall

Model-facing same-session recall/search tools over the durable session log, plus a
human-facing `/recall` slash command.

## Install

From npm (published):

```bash
dsh plugin --profile web add @blake-r/dsh-tool-trajectory-recall
```

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-tool-trajectory-recall
```

## What it does

A bundle package in the dsh-plugins monorepo. See the header comment in
`src/dsh-tool-trajectory-recall.mjs` for full behavior.

### `recall` tool

Restores the exact original content of earlier events by a typed reference
(`seq` selection, `result` pointer, or `checkpoint` ordinal/pointer). Every
requested seq is returned in full projected original text as
`[seq N: <role>]\n<full body>`. There are no token budgets. The returned object
keeps the `skipped: 0` marker, `tokens` remains a meter of the returned
entries' estimated token counts, and `truncated` is true only when a windowed
recall cut an event short.

Optional line-based paging: pass `limit` (lines per event) and/or `offset`
(1-based first line) to window a large event. A windowed recall is marked
partial (`truncated: true`) with a continuation marker, so the model pages
again with a larger `limit` or a later `offset` instead of mistaking the window
for the whole result.

Spilled outputs: when a tool result was spilled by `dsh-spill-policy`, the full
output lives in a `plugin:spill` sibling record. `recall type="seq"` restores
it directly; `recall type="result"` also resolves through the tool/result's
callId to the sibling, so the natural `result N` pointer reaches the full
content too.

### `search` tool

Keyword/regex search over the durable event log (case-insensitive,
Unicode-aware), scanning **from the end backwards** so freshest matches come
first. Every matching event produces exactly one index line:

```
[seq N: <label>] - K match(es) · first match at line L
```

where `<label>` is the tool name for tool-call/tool-result rows (resolved by
scanning earlier events for the matching tool call id), the spill record's own
tool name for `plugin:spill` siblings, or the message role otherwise, and `K`
is the total number of pattern occurrences in that event's projected body
text. Each hit also carries the 1-based line `L` of its first match, computed
against the decoded spill body, so the model can page straight to the needle
with `recall`'s `offset`. There are no hit caps, line caps, or token budgets.
Search matches full spilled content too — a needle buried in a spilled blob
that the model never saw inline is still found. The trailing hint line points
back at `recall` with a `(seq N)` pointer to restore any hit's full original
content.

### `/recall` slash command

The same search exposed as a human-facing slash command: `/recall
<keyword|regex>`. Its result is appended to the session as a user message
(`source: { kind: "plugin:recall", form: "recall" }`) so the next
model turn sees it. Per the "full inline or sibling" rule, an index estimated
at more than 1000 tokens is spilled to a `plugin:spill` sibling record first
(when the dsh-session loader is available), appending only a short notice with
the sibling's seq; otherwise the full index text is appended inline. The
appended message carries the matching events' seqs as `sourceEventSeqs`
provenance.

## Notes

The recall/search cores and compiler helpers are vendored from an upstream
compaction engine whose algorithm this plugin adapts for model-facing
same-session recall/search tools. No tool output is ever truncated: recall
returns every requested seq in full (or a paged window it explicitly marks as
partial), and search returns every matching event as one index line.

The `plugin:spill` sibling contract (record type string, `{ toolName, callId,
content }` data shape, and seq semantics) is shared with `dsh-spill-policy`; the
two packages must stay in lockstep on it, or recall silently degrades to the
generic JSON fallback for the record.