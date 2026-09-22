# dsh-spill-policy

Replacement spill policy for DeepSeek Harness (dsh).

## What it does

Bounds the model-facing result of oversized tool calls: instead of the full
output, the model sees a short head/tail preview, an omission marker, and a
notice pointing at the full artifact in the spill store (`ctx.spillStore`,
`@deepseek-ai/dsh-spill-local`). The model reads the artifact back via `read`
when it actually needs the data.

Divergence from base `@deepseek-ai/dsh-spill-policy`:

- Much tighter byte cap (`maxInlineBytes`, default 4096 vs the base 50000).
- Structured results (JSON/JSONL/CSV/TSV/XML/HTML/YAML) get a first-level
  structural summary; the artifact is saved verbatim, never reformatted.
- `excludeTools` (default `["read", "skill"]`) keeps those results inline in
  full.
- The omission marker is reserved in the preview budget, so the replacement
  never exceeds `maxInlineBytes` by construction.

## Mount

The bundle patch disables the base `spill-policy` row and inserts
`dsh-spill-policy`. The web profile supplies the deployment config:

```yaml
- id: dsh-spill-policy
  config:
    maxInlineBytes: 4096
    excludeTools:
      - read
      - skill
```

Plus the `link:` dependency in `home/profiles/web/package.json` and the entry
in `dsh.profile.bundles`.

## Test

```sh
node --check src/dsh-spill-policy.mjs
```