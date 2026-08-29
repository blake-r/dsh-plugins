# @blake-r/dsh-compaction-micro

Per-request trajectory re-composition for the kb preset.

## Install

From npm (published):

```bash
dsh plugin --profile web add @blake-r/dsh-compaction-micro
```

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-compaction-micro
```

## What it does

A bundle package in the dsh-plugins monorepo. See the header comment in
`src/dsh-compaction-micro.mjs` for full behavior.

The compiler is vendored (trimmed) from an upstream compaction engine whose
algorithm this plugin adapts for per-request trajectory re-composition.
