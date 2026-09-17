# dsh-client-ui-composer-top

CSS-only DSH Web UI plugin: moves the composer (prompt input) from the bottom
of the conversation area to the top, pinned under the header.

## Behavior

- **Composer at the top** — the composer seat becomes the first, sticky
  element of the scroll area in the active conversation phase. The header is
  untouched; hero and settling phases keep their original layout. The seat's
  backdrop is fully opaque (`--dsw-alias-bg-base`) instead of the stock 36px
  gradient, so message text never shows through beside or under the composer
  card (matters when a wider message column, e.g. `dsh-client-ui-wider-chat`,
  extends past the card's sides).
- **User dialogs hang from the top edge** — question cards
  (`dsh-client-ui-user-questions`) and permission approvals
  (`dsh-client-ui-approval`) render through the `conversation.composer` slot,
  i.e. they replace the composer seat, so they automatically anchor to the top
  edge as well. Defensive clamps keep them inside the visible area
  (`calc(100dvh - 140px)` hard bound on top of the existing `60vh`/336px
  clamps).
- **Dock panels below the input** — the request queue and todo docks
  (`conversation.input.dock` slot) are re-ordered under the input bar via
  `flex-direction: column-reverse` on the composer stack.
- **Scroll-to-bottom button stays at the bottom edge** — the
  `--dsh-composer-height` offset (meant for the bottom composer) is zeroed on
  the message column; the turn rail (a sibling) keeps the real height and
  stays centered in the visible message area.
- **Trajectory overlay** — the composer seat covers the message area from the
  top edge instead of the bottom.

## Implementation notes

- Pure CSS: a single `<style>` tag injected at client-module materialization
  (guarded by `data-plugin-css` to survive HMR/reload).
- All selectors use stable data attributes from the official client bundles
  (`data-composer-seat`, `data-phase`, `data-chat-flow`, `data-question-key`,
  `data-approval-scroll`, `data-queue-dock`, `data-todo-dock`,
  `data-conversation-composer-overlay`), so no patches to system packages are
  needed.
- The `apply`/`inject` exports are no-ops required by the client-module
  contract.

## Mounting

Add `@blake-r/dsh-client-ui-composer-top` to the web profile bundle list
(`home/profiles/web/package.json` → `dsh.profile.bundles`) and run
`pnpm install` (or symlink it into the profile's `node_modules/@blake-r/`).