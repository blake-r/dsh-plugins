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
requested seq is returned **untruncated** in full projected original text as
`[seq N: <role>]\n<full body>`. There are no token budgets: output is
either fully inline or fully in a file artifact. The returned object keeps the
`skipped: 0` and `truncated: false` markers always, and `tokens` remains a
meter of the returned entries' estimated token counts.

### `search` tool

Keyword/regex search over the durable event log (case-insensitive,
Unicode-aware), scanning **from the end backwards** so freshest matches come
first. Every matching event produces exactly one index line:

```
[seq N: <label>] - K match(es)
```

where `<label>` is the tool name for tool-call/tool-result rows (resolved by
scanning earlier events for the matching tool call id) or the message role
otherwise, and `K` is the total number of pattern occurrences in that event's
projected body text. There are no hit caps, line caps, or token budgets.
The trailing hint line points back at `recall` with a `(seq N)` pointer to restore
any hit's full original content.

### `/recall` slash command

The same search exposed as a human-facing slash command: `/recall
<keyword|regex>`. Its result is appended to the session as a user message
(`source: { kind: "plugin:recall", form: "recall" }`) so the next
model turn sees it. Per the "full inline or file artifact" rule, an index
estimated at more than 1000 tokens is spilled to the `spillStore` file
artifact first (when available), appending only a short notice with the artifact
locator; otherwise the full index text is appended inline. The appended
message carries the matching events' seqs as `sourceEventSeqs` provenance.

## Notes

The recall/search cores and compiler helpers are vendored from an upstream
compaction engine whose algorithm this plugin adapts for model-facing
same-session recall/search tools. No tool output is ever truncated: recall
returns every requested seq in full, and search returns every matching event as
one index line.