# @blake-r/dsh-tool-trajectory-recall

Model-facing same-session recall/search tools over the durable session log.

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

The recall/search cores and compiler helpers are vendored from an upstream
compaction engine whose algorithm this plugin adapts for model-facing
same-session recall/search tools.
