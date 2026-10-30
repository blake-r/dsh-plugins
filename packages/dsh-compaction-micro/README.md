# @blake-r/dsh-compaction-micro

Per-request trajectory re-composition with mid-turn firing.

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

Three behaviors:

1. **Per-request re-composition (turn/end)** — after every completed turn, each
   assistant/tool session since our last content re-installation is folded into
   a compact, recall-linked view: tool calls become `* name "description"
   (seq N -> result M)` pointers, results collapse into those pointers,
   reasoning is dropped, assistant text stays verbatim (back-linked), user
   attachments fold into `[image]` / `[document]` links. Nothing is deleted:
   the durable append-only log keeps everything, and `recall` / `search` work
   on replaced ranges.

2. **Mid-turn firing (agent/pre-step)** — a long agent turn never fires
   `turn/end`, so `dsh-compaction-basic` (a lossy LLM summarization) could fire
   first at `agent/pre-step` and destroy the model's working reasoning. This
   plugin also listens at `agent/pre-step` (BEFORE basic, `{ prepend: true }`,
   synchronous fold) and, when the surface crosses a configurable pressure
   threshold, structurally folds the OLDEST foldable content of the current
   turn beyond a locked window into a one-liner checkpoint. Basic then measures
   the post-fold surface on the same step and never fires.

3. **Per-turn consolidation (3.8)** — every replacement is a micro-checkpoint
   carrying `source.micro` metadata. At the next normal `turn/end` the turn's
   checkpoint block plus its remaining live content is folded into ONE per-turn
   node whose content follows the SAME fold semantics as every other fold
   (reasoning dropped, tool calls/results folded to pointers, everything else
   kept verbatim — mid-turn checkpoints carry over verbatim in surface order).
   Checkpoint NODE overhead is capped at O(turns) while the concentrated
   content is preserved (user decision); the context grows gradually per turn
   and basic compaction remains the long-range backstop (e2c13124 lesson:
   47-58 folds → 101K tokens).

4. **Frame policy (3.9)** — old copies of injected frames (skill-catalog,
   agent-instructions, goal, runtime-context) are deleted from the surface,
   keeping only the LATEST version per frame type. Real user messages and
   non-dedupe live messages always stay. The durable log is unchanged.

The compiler is vendored (trimmed) from an upstream compaction engine whose
algorithm this plugin adapts for per-request trajectory re-composition.

## Configuration

The plugin reads its options from the plugin row's `config` in the profile
patch:

- `compactOnAbnormal` (boolean, default `false`): **inert** — retained only for
  config-surface compatibility. Reasoning removal is owned by `intermediateFold`:
  on an abnormal turn end (`error`, `max-tokens`, `aborted`, `blocked`) or a
  reasoning-only turn, the plugin skips compaction entirely and the turn's
  reasoning ALWAYS stays live (especially with `intermediateFold` off), so the
  interrupted reply / chain of thought survives for a "Continue" prompt.
- `intermediateFold` (boolean, default `false`): at `agent/pre-step`, climb from
  the END of the surface and fold EVERYTHING up to the last reasoning-with-a-
  text-answer (the anchor) into one user message that removes ONLY the reasoning
  blocks (visible text / tool-call arguments / result text stay fully visible).
  The anchor and everything at or after it stay fully live — its reasoning is
  the "latest" the model continues from, so it always stays on the surface.
  Every step OLDER than the anchor is folded, including text-bearing steps,
  failed steps and reasoning-only blocks. The fold fires only when there is at
  least one assistant step with a text answer + reasoning (the anchor) and at
  least one foldable step older than it.
- `includeReasoning` (boolean, default `false`): when `true`, assistant
  `reasoning` blocks are kept verbatim in the folded output instead of being
  dropped. Mid-turn checkpoints always drop reasoning (Q24) regardless of
  this flag.
- `toolKeyArgFields` (object, default per-tool): maps a tool name to the
  argument-field names preferred for the one-liner label (first present wins;
  `null` / `[]` remove a tool's fallback). Defaults: `glob` → `pattern`,
  `grep` → `pattern`, `read`/`write`/`edit` → `file_path`.
- `chunkTokens` (positive integer, default `16384`): the token budget of one
  chunk-object when slicing the mid-turn foldable stream.
- `lockedChunks` (positive integer, default `2`, kept at 2 by the guard):
  the number of chunk-objects at the live tail that are NEVER folded mid-turn
  (the model's live window, 16385..32768 tokens by default).
- `thresholdRatio` (positive finite number, default `0.8`): same knob name and
  default as `dsh-compaction-basic` — the micro threshold is
  `floor(min(W*thresholdRatio, W − maxTokens − headroomTokens)) − chunkTokens`,
  exactly one chunk budget below basic's, so micro always fires first.
- `headroomTokens` (non-negative integer, default `65536`): reserved lead room
  for basic's agent prompt, same name/default as basic.

Example:

```yaml
- id: compaction-micro
  config:
    intermediateFold: true
```

## Development

```bash
npm run check   # node --check src/dsh-compaction-micro.mjs
```

Plugin `.mjs` changes take effect on the next instance launch (no hot-reload).