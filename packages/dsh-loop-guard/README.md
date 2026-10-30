# @blake-r/dsh-loop-guard

DSH host plugins guarding agent loops, shipped as ONE package exposing TWO
plugin rows:

- **reasoning-loop-guard** (`@blake-r/dsh-loop-guard/reasoning-loop-guard`) —
  detects reasoning loops at streaming time and either aborts a degenerate
  block (intra-block repetition) or reminds the model to make progress
  (cross-block repetition across steps).
- **repeat-pattern-reminder** (`@blake-r/dsh-loop-guard/repeat-pattern-reminder`)
  — detects repeated tool calls by state hashing (MD5 of the tool name +
  canonical arguments) and complex alternations by Floyd's cycle finding, and
  reminds the model to change course.

Both rows share the internal coordination module (`src/dsh-loop-guard-shared.mjs`),
which keeps one shared flag pair per agent so the two plugins never double-inject
a reminder on the same step, plus the detection primitives.

## Two rows, two configs

The two rows are independent plugins with separate ids and separate configs.
The profile's `cordis.patch.yml` keeps the two configs apart (they are NOT
merged):

```yaml
- id: dsh-host-reasoning-loop-guard
  name: '@blake-r/dsh-loop-guard/reasoning-loop-guard'
  config:
    thresholds: [ 3, 5, 8 ]
    window: 48
    n: 24
    maxRepeats: 2
    segmentChars: 256
    abortIntraBlock: true
    charRunThreshold: 64
    tokenRunThreshold: 8
    include: []
    exclude: []

- id: dsh-host-repeat-pattern-reminder
  name: '@blake-r/dsh-loop-guard/repeat-pattern-reminder'
  config:
    thresholds: [ 3, 5, 8 ]
    include: []
    exclude: []
    argumentsPreviewChars: 500
```

## Install

```bash
dsh plugin --profile web add @blake-r/dsh-loop-guard
```

The bundle patch inserts both rows; the profile patch overrides each row's
config by id.