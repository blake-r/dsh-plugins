# dsh-client-ui-recent-sessions-switcher

A DeepSeek Harness Web UI plugin: a compact recent-sessions switcher in the
conversation header. It shows the current session's workspace basename and
title, a status dot (running / idle / unread), and a dropdown of the 8 most
recently-updated sessions. Clicking an item opens that session.

## Archive

Each dropdown row carries an archive action: the `IconArchiveOutline20` glyph
from `@deepseek-ai/dsh-client-ui-primitives`, sharing a single trailing slot
with the current-session check mark (`.rss-itemTrailing`). At rest the slot
shows the check (for the current session) or nothing; hovering the row (or
focusing the button via keyboard) swaps it for the archive glyph. Clicking it
archives the session through the `workspaces` service (`archiveSession`),
closes the dropdown, and the row disappears. Archived sessions are excluded
from the dropdown and from the badge counters.

Archiving the **currently-selected** session auto-switches the switcher to the
freshest remaining session: dsh clears the selection when the current session
is archived, so once the archive resolves the switcher opens the most
recently-updated session that is still visible (non-blank, non-subagent,
non-archived). When no other session remains, the cleared/empty state is left
as-is.

## Status dots

Mirrors dsh's `StateDot`:

- **needs input** — orange dot (a pending interaction: approval, plan review,
  or a question awaiting the user)
- **running** — animated matrix (DeepSeek brand blue `#5686fe`)
- **completed** — green dot (idle with unread output)
- **idle** — transparent dot with a silver outline

Because dsh's `completed` heuristic stays `false` for the currently-selected
session, a session that finished while the window was unfocused would otherwise
render as "idle, all read". The plugin forces the green ("unread") dot with a
CSS class: armed the moment the window loses focus while the current session
was still running, cleared on refocus.

## Badge

The counter next to the trigger shows the total number of active agents
(working or awaiting input) across all sessions, including the currently
selected one. Each session counts at most one agent: an agent paused on a
question/approval keeps its loop phase "running", so it is counted under
"awaiting input" only, never as both working and awaiting input. It is
highlighted green when any idle agent has unread output and orange when any
agent awaits input (orange outranks green). The highlight fills the whole
pill: the badge background becomes the state color (success green / warn
orange) with white text, and the neutral border is dropped.

## Current session

The dropdown row for the currently-selected session is highlighted: its label
and status text render in the business state color
(`--dsw-alias-state-business-primary`) with a medium weight, and a trailing
check glyph (`IconCheckOutline16`) marks the row — mirroring dsh's own Menu
selected-item pattern. The color is applied to the row's main button
(`.rss-current .rss-itemMain`) so it wins over the button's default label
color; the check is rendered only for the row whose id equals the active
`sessionId`, and it occupies the same trailing slot as the archive action (see
above), fading out on row hover so the archive glyph can take its place.

## Layout

- `lib/index.js` — host half (empty `apply`; the plugin is pure UI, the host
  half exists so the row appears in the host Loader).
- `lib/client.js` — the browser bundle in the client-modules format
  (`window.__ModuleLoader__.load({ id, factory })`).
- `src/client.js` — readable source mirror of the browser bundle.
- `cordis.patch.yml` — inserts the plugin row into the web profile roster.

## Install

```sh
dsh plugin --profile web add link:<repo>/packages/dsh-client-ui-recent-sessions-switcher
```

The package declares `dsh.client` (platform `web`, injects `slots`, `sessions`
and `workspaces`), so `dsh-client-modules` discovers the browser half
automatically.