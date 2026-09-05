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

## Configuration

The plugin reads its options from the plugin row's `config` in the profile
patch:

- `compactOnAbnormal` (boolean, default `false`): when a turn ends
  abnormally (`error`, `max-tokens`, `aborted`, `blocked`) or reasoning-only,
  the plugin normally folds everything up to the previous turn and keeps only
  the last (problematic) session live so the interrupted reply / chain of
  thought survives a "Continue". Set this flag to `true` to enable that
  keep-last-session behavior. When `false` (the default), compaction is skipped
  entirely on such turn ends, so past sessions are never compressed on a
  request failure.

Example:

```yaml
- id: dsh-compaction-micro
  config:
    compactOnAbnormal: false
```
