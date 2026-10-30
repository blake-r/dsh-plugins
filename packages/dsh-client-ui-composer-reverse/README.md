# dsh-client-ui-composer-reverse

CSS+JS DSH Web UI plugin: reverses the composer layout and its popovers when
the composer is pinned at the top of the conversation area (the
`dsh-client-ui-composer-top` layout).

## Problem

With the composer pinned at the top, every composer popover that opens upward
slides under the Chat/Trajectory header and gets clipped by the scroll
container — the top lines of the context-meter panel and the access-mode menu
are cut off, and the portaled stats dialogs / model menu cover the header.

## Behavior

All rules activate only while the composer seat is stuck at the top of the
viewport (a small client script toggles `body.dsh-composer-reverse-stuck`);
without that layout the plugin is inert.

- **Full stack reversal** — the composer stack flips so the dock row (recent
  sessions, request queue, todo) sits below the input bar, and the input bar
  flips so the stats dock sits above the card. Everything that was at the
  bottom of the composer moves to the top.
- **Inline popovers open downward** — the access-mode menu
  (`[role="menu"]`) and the context-meter panel (`[role="dialog"]`) inside the
  composer card re-anchor below their trigger (`top: calc(100% + …)`) instead
  of growing upward, so the scroll container can no longer clip them.
- **Portaled popovers open downward** — the stats dialogs
  (`data-session-stats-details` / `data-session-stats-usage`) and the model
  menu are positioned by JS with `side: "top"` and clamped to the viewport top
  edge; the client script tracks the anchor's bottom edge into CSS variables
  and a `translateY` shifts each popover from the clamped top to just below
  its anchor.

## Implementation notes

- A single `<style>` tag injected at client-module materialization (guarded by
  `data-plugin-css` to survive HMR/reload) plus a small `apply()` that toggles
  the gate class and tracks the anchors (MutationObserver + scroll/resize,
  rAF-throttled).
- Selectors use stable data attributes from the official client bundles
  (`data-composer-seat`, `data-composer-card`, `data-composer-stats`,
  `data-session-stats-details`, `data-session-stats-usage`, `data-slot`) and
  ARIA roles, so no patches to system packages are needed. The model-menu
  rule matches `aria-label="Model and reasoning effort"` (the English default
  of `menu.aria`); localized UIs need that label adjusted.
- The `apply`/`inject` exports follow the client-module contract; `apply` is
  not a no-op here (it drives the gate class and the anchor tracking).

## Mounting

Add `@blake-r/dsh-client-ui-composer-reverse` to the web profile bundle list
(`home/profiles/web/package.json` → `dsh.profile.bundles`) and run
`pnpm install` (or symlink it into the profile's `node_modules/@blake-r/`).