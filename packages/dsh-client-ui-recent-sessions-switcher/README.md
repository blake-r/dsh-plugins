# dsh-client-ui-recent-sessions-switcher

A DeepSeek Harness Web UI plugin: a compact recent-sessions switcher in the
conversation header. It shows the current session's workspace name and
title, a status dot (running / idle / unread), and a dropdown of the 8 most
recently-updated sessions. Clicking an item opens that session.

## Workspace names

Each row (and the header trigger) labels a session with its **workspace
name**, not the directory basename: a session accounted to a Workspace shows
that Workspace's user-chosen `title` (which may differ from the directory
name — e.g. a Workspace titled `goals` rooted at `.../Goals`), mirroring
dsh's own resolution in the workspace browser and the hero workspace chip.
Sessions not accounted to any Workspace (no matching `cwd`) fall back to the
`cwd` basename.

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
- **failed last request** — red dot (idle with the last request errored or the
  last turn abandoned; see below)
- **idle** — transparent dot with a silver outline

Red and green are **derived from the session journal's tail**, read through the
session-controller remote (`projections` for the log cursor, then `page` for
the last turn window), and gated by a **host-persisted read marker** (see
"Read markers"). The state is a fact about the journal, not an unread
reminder: a reload recomputes it honestly from the journals (no localStorage),
and the durable marker decides whether that state is still worth flagging.

Red reports a session whose last turn is **unfinished** (a `turn/start` with no
following `turn/end` while the session is not running — an abandoned turn) or
whose last `turn/end` reason is `error` or `max-tokens`. A journal that ends
inside an open turn is balanced by the server with synthetic `interrupted`
closers sharing the last real event's timestamp; the plugin recognizes that
signature and still reports the turn as open (red), while a genuinely
interrupted turn (its `turn/end` carries its own later time) renders silver.
`aborted` / `interrupted` turns are neither red nor green.

Green reports a last `turn/end` reason of `completed`. Both red and green
require the session to be idle, exclude the currently-selected session, and
clear once the session has been viewed: leaving a session writes a durable
read marker for it, and a session counts as unread only while its `updatedAt`
is newer than that marker (see "Read markers" — the marker survives page
reloads). A session whose journal holds only the title event (no turns, no
messages) is treated as blank and excluded from the dropdown.

One in-memory fallback remains: the host's `api-session/error` event for a
session whose journal is empty (background-activation failure) marks it red
until reload — there is no journal content to acknowledge. For sessions with
content the same event only supplies a title message; the color comes from the
journal.

## Badge

The counter next to the trigger shows the total number of active agents
(working or awaiting input) across **all** sessions — the current one, every
other visible session, and every running subagent (including subagents of
archived sessions; archiving does not stop an agent). Each session counts at
most one agent: an agent paused on a question/approval keeps its loop phase
"running", so it is counted under "awaiting input" only, never as both working
and awaiting input. A pending interaction counts only while its agent is still
running (a stopped agent leaves a stale pending interaction behind). The badge
is highlighted orange when any agent awaits input (outranks red and green), red
when **some visible session's journal tail flags it** (last turn abandoned,
errored, or max-tokens — see "Status dots"; outranks green), and green when
**some visible session finished cleanly with unread output**. The number reads
the winning count (a green pill never shows "0"), else the total active count;
both branches cap at `9+`. The tooltip breaks the count down as "working (in
subagents), needs input, failed last request (with the first error message),
finished with unread output".

Because green is per-session, a running session in one conversation no longer
suppresses the green that a completed conversation in another earns: the badge
lights for genuinely finished agents with unread output regardless of unrelated
activity. Both red and green exclude the currently-selected session and clear
once the session has been viewed (durable read marker, see "Read markers").

## Read markers

"Viewed" is not an in-memory flag: the switcher keeps a **durable last-seen
timestamp per session**, so the unread state survives page reloads and browser
restarts.

- **Predicate.** A session is unread iff its list row's `updatedAt` (the
  durable last-activity stamp maintained by the session controller) is newer
  than the marker: `updatedAt > lastSeenAt(id)`. **No marker means read**, so
  the first run after install flags nothing.
- **Where it lives.** Host-side, through the base durable storage: domain unit
  `recent_sessions_ack` (version 1), table `acks`, key `<sessionId>`, value
  `{ lastSeenAt }`. Session ids are globally unique, so one flat table covers
  every workspace, and the file survives in
  `$DSH_HOME/storages/recent_sessions_ack.json` (gitignored, atomic whole-file
  writes and zod validation come from the base storage layer).
- **When it is written.** Leaving a session — the slot's `sessionId` changes —
  writes `lastSeenAt = now` for the session the user just left; its content was
  on screen. The currently-selected session stays excluded from markers by id.
- **Offline activity.** A session that gained messages while the page was
  closed comes back unread after a reload: its `updatedAt` moved past the
  persisted marker. Re-running a session does the same, so hygiene never
  deletes a live session's marker (only sessions that vanished from the list).
- **Channel.** A custom Remote service on the host
  (`lib/index.js`, class extending `TypertRemoteService`, namespace
  `recentSessions`) exposes `getAck()` — every marker as
  `{ [sessionId]: lastSeenAt }` — and `ack(sessionId, lastSeenAt)`. The
  browser half mounts its own contribution with `ctx.remote.$mount(...)` (the
  client-side remote is not a Proxy, so the descriptors, including strict input
  codecs, have to be declared) and calls `ctx.remote.recentSessions.*`.
- **Graceful degrade.** If the mount or `getAck()` fails (an older host without
  the service, a rejected RPC), the map stays empty, the mode is `down`, and
  the switcher behaves exactly as before the persistence existed — no markers
  instead of a broken switcher, and no console noise. Failed `ack()` writes are
  swallowed; the next successful one persists the position.

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

The dropdown always renders the current session, even when it falls outside the
8-slot cap: a selected parent whose subagents are working must stay reachable
(and visible with its activity icon) no matter how many fresher sessions
compete for the slots. Active, red, input-requiring, and descendant-active
sessions are prioritized ahead of the most recently updated others.

## Layout

- `lib/index.js` — host half: opens the `recent_sessions_ack` storage unit and
  publishes the `recentSessions` Remote service (`getAck` / `ack`) that backs
  the read markers (see "Read markers"). It injects `storageDomain`.
- `lib/client.js` — the browser bundle in the client-modules format
  (`window.__ModuleLoader__.load({ id, factory })`); this is what the browser
  actually loads.
- `src/client.js` — readable source mirror of the browser bundle. There is no
  build step: the two are kept in sync by mechanical rules — drop the
  `import ... from "@deepseek-ai/dsh-client-ui-primitives"` line (the bundle
  `require`s `react` and the primitives from the platform seed), `export const
  inject` / `export function apply` become plain declarations assigned to
  `exports` in the wrapper tail, the `css` array and its `<style>` guard exist
  only in the bundle, and every line is indented by two tabs inside the
  factory.
- `cordis.patch.yml` — inserts the plugin row into the web profile roster
  (host-loaded package; the browser half is discovered from the `dsh.client`
  manifest, so no second row is needed).

## Install

```sh
dsh plugin --profile web add link:<repo>/packages/dsh-client-ui-recent-sessions-switcher
```

The package declares `dsh.client` (platform `web`, injects `slots`, `sessions`,
`workspaces`, `uiWorkspace` and `remote`), so `dsh-client-modules` discovers the
browser half automatically.

Dependencies are declared explicitly (`@deepseek-ai/dsh-typert-protocol`,
`@deepseek-ai/dsh-storage-domain` and `zod` for the host half): pnpm resolves
each package in isolation, so a host import that is not listed in
`dependencies` fails to resolve at load time.

Check the sources without launching anything:

```sh
pnpm check   # node --check lib/index.js && node --check lib/client.js && node --check src/client.js
```