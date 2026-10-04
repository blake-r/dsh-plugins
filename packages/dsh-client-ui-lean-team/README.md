# dsh-client-ui-lean-team

DSH Web UI plugin: the Lean Team kanban board's entry.

- **The icon** — a kanban/board glyph from the primitives' icon set
  (`IconPanelLeftOutlineMedium`, 16px), registered into the conversation
  header's utilities row (`conversation.session.header.utilities`) via the
  `slots` service — the sessions-switcher's mechanism — ordered near it
  (`order: -15`), styled like the neighboring header icons, tooltip "Lean Team".
- **The modal** — the icon's click opens the Lean Team Board as a 100%-covering
  modal: a fixed overlay (`position:fixed; inset:0`) above the GUI's chrome
  with the kanban UI in a same-origin iframe (`src="/lean-team/"`). No
  `window.open`, no navigation — the address bar stays unchanged (works in
  Chrome and the tauri webview). The close: the X button in the bar's corner
  plus the Escape key. The overlay's background is the GUI's elevated surface
  (`--dsh-bg-elevated`).

The host half (`lib/index.js`) is a no-op — the row exists so the package
mounts and the `dsh.client` declaration is discovered by dsh-client-modules.