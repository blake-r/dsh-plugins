# @blake-r/dsh-client-ui-wider-chat

DSH web host plugin: widen the conversation output column to (almost) full
width while keeping the composer (input) card at its current width.

The conversation body element declares two CSS variables —
`--dsh-chat-content-width` (message column max-width) and
`--dsh-composer-card-max-width` (composer card max-width). The plugin overrides
them on `[data-conversation-content]` with `!important` so the two stay
decoupled: the dialog becomes `max(748px, calc(100% - 64px))` (full width minus
a 64px margin, never narrower than the current 748px minimum), while the
composer stays fixed at 780px.

The style is injected into the served index.html head via the
`webserver/index-inject` event (kind: `style`). The `[data-conversation-content]`
attribute is stable across client rebuilds/upgrades, so the override survives
hashed CSS-module class renames.

## Install

```bash
dsh plugin --profile web add @blake-r/dsh-client-ui-wider-chat
```

The plugin is host-only: reference it by name in the profile's
`cordis.patch.yml` (a plain row, no `insert`), e.g.

```yaml
- id: wider-chat
  name: '@blake-r/dsh-client-ui-wider-chat'
```