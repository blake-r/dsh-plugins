# dsh-client-ui-compaction-micro

DSH Web UI plugin: renders a transcript marker at every `dsh-compaction-micro`
compaction point — *"Micro-compaction — N history items (~M tokens)"*. The seq
range is not shown; consecutive micro compactions are collapsed into one
marker that sums items and tokens across the run.

## What it does

`dsh-compaction-micro` emits a `compaction/summary` event (with
`shadowedSeqs` / `shadowedTokenCount` / `shadowedRange`) right before each
replacement commit. The built-in UI compaction marker is hardwired to the
standard provider (`source.plugin === "compact"` and a `compactionId`), so the
micro provider's replacements render nothing in the transcript. This plugin
claims exactly the micro-style summaries — `compaction/summary` events that
carry **no** `compactionId` (the standard provider always emits one, so there
is no overlap) — and renders its own marker via the `conversation.chat.node`
keyed slot.

No change to `dsh-compaction-micro` is required: implementation and
visualization stay separate.

## Layout

- `src/client.js` — source mirror of the browser bundle.
- `lib/client.js` — the actual browser bundle (client-modules format).
- `lib/index.js` — host half (no host-side behavior; makes the row appear in
  the host composition).
- `cordis.patch.yml` — inserts the plugin row into the web profile roster.

Keep `src/client.js` and `lib/client.js` in sync; the browser loads
`lib/client.js`.

## Wiring

The bundle is registered through the web profile's `dsh.profile.bundles`
list (pnpm workspace symlink) and the `dsh.bundle.patch` manifest field, which
applies `cordis.patch.yml` to insert the plugin row. The browser half is
discovered through the package.json `dsh.client` declaration.
