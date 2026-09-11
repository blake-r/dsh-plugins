# dsh-client-ui-recent-sessions-switcher

A DeepSeek Harness Web UI plugin: a compact recent-sessions switcher in the
conversation header. It shows the current session's workspace basename and
title, a status dot (running / idle / unread), and a dropdown of the 8 most
recently-updated sessions. Clicking an item opens that session.

## New-session screen

The switcher also appears on the new-session screen (the hero layout, prompt
card centered), as the trailing control of the hero chip row: on the same line
as the workspace and agent-preset chips, right-aligned with them, styled as a
peer pill. Nothing patches a dsh package: the second appearance is a second
Slot registration of the same component.

Why the header registration cannot cover the hero screen:

- dsh renders `conversation.session.header` only when a Session is bound, and
  `ConversationSessionHeader` unmounts all header chrome while the bound
  Session is blank (`hideChrome = session.blank && conversationPhase(...) ===
  "blank"`). Every `conversation.session.header.*` slot is therefore absent on
  the new-session screen.
- The hero region offers only single-occupancy slots
  (`conversation.hero.brand.mark`, `conversation.hero.workspace`,
  `conversation.hero.agentPreset`), already taken by the brand, workspace
  picker and agent-preset chip. A single slot admits one entry per priority,
  so using one would either collide (registration error) or shadow the
  existing occupant.

What the plugin does instead: it registers the same switcher component a
second time in `conversation.input.dock` — the session-scoped list slot the
composer stack renders inside the hero, between the workspace/agent-preset row
and the prompt card. A list slot takes any number of entries, so nothing is
displaced. The dock entry injects `heroDock: true` and registers as
`recent-sessions-switcher-hero`.

The hero copy is laid out as part of the hero chip row rather than as a row of
its own: the dock row collapses to zero height and the trigger floats up onto
the chips' baseline (`position:absolute`, `right:16px`,
`bottom:var(--rss-hero-dock-lift,8px)` — the 8px dsh puts between the two
rows), with the chips' own pill metrics (28px, 16px radius, 8px padding,
13px/500, `label-primary`). On the hero the leading status dot is replaced by
`IconClockOutline16`, since the dot reports the bound Session and no Session is
bound there; the label is shortened to "Recent" (full text in the tooltip). The
activity badge behaves exactly as elsewhere: it is always rendered, showing a
muted `0` when nothing is running or awaiting input (a badge that appears and
disappears on every run made the pill's width jump). The dropdown opens upward
over the empty headline area, so it does not cover the prompt card. With no
session to switch to there is nothing to show: the hero trigger renders nothing
at all rather than an inert control whose menu would read "No sessions".

The hero copy of the switcher is mounted in every phase but shown only while
dsh's conversation root carries the stable `data-phase="hero"` attribute
(`settling`/`active` hide it), so exactly one copy is visible at a time: the
dock one on the new-session screen, the header one afterwards.

While no workspace exists at all, `startSession` clears the Session selection
instead of creating one; no session-scoped slot renders in that state, and the
switcher would have nothing to switch between anyway.

## Archive

Each dropdown row carries an archive action: the `IconArchiveOutline20` glyph
from `@deepseek-ai/dsh-client-ui-primitives`, sharing a single trailing slot
with the current-session check mark (`.rss-itemTrailing`). At rest the slot
shows the check (for the current session) or nothing; hovering the row (or
focusing the button via keyboard) swaps it for the archive glyph. Clicking it
archives the session through the `workspaces` service (`archiveSession`),
closes the dropdown, and the row disappears. Archived sessions are excluded
from the dropdown and from the badge counters.

Archiving the **currently-selected** session auto-switches the switcher to
another session: dsh clears the selection when the current session is
archived, so once the archive resolves the switcher prefers the most
recently-updated session that stays in the **same working directory** as the
archived one (non-blank, non-subagent, non-archived). When no such session
exists — or the archived session had no cwd — it falls back to the most
recently-updated session overall. When no other session remains, the
cleared/empty state is left as-is. Archiving a non-current session never
changes the selection.

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