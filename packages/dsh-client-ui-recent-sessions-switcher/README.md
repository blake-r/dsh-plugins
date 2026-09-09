# dsh-client-ui-recent-sessions-switcher

A DeepSeek Harness Web UI plugin: a compact recent-sessions switcher in the
conversation header. It shows the current session's workspace basename and
title, a status dot (running / idle / unread), and a dropdown of the 8 most
recently-updated sessions. Clicking an item opens that session.

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

The package declares `dsh.client` (platform `web`, injects `slots` and
`sessions`), so `dsh-client-modules` discovers the browser half automatically.