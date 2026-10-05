# dsh-client-ui-lean-team

DSH Web UI plugin: the Lean Team kanban board's entry.

- **The labeled entry** — a compact pill in the conversation header's utilities
  row (`conversation.session.header.utilities`): the kanban/board glyph (16px,
  the primitives' icon set, `IconPanelLeftOutlineMedium`) plus the visible text
  label "Lean Team" (the header's label style, 13px), the pill's height
  matching the header's 28px utility squares, the label-secondary color, the
  hover background, the same padding rhythm as the neighboring header controls
  (the sessions-switcher's trigger). Registered via the `slots` service — the
  sessions-switcher's mechanism — ordered near it (`order: -15`), tooltip
  "Lean Team", aria-label "Open the Lean Team kanban board".
- **The modal** — the entry's click opens the Lean Team Board as a 100%-covering
  modal: a fixed overlay (`position:fixed; inset:0`) above the GUI's chrome
  with the kanban UI in a same-origin iframe (`src="/lean-team/"`). No
  `window.open`, no navigation — the address bar stays unchanged (works in
  Chrome and the tauri webview; the webview's `on_navigation` gate allows the
  same-origin iframe). The close: the X button in the bar's corner (an inline
  SVG — a real DOM node, never a React element) plus the Escape key. The
  overlay's background is the GUI's elevated surface (`--dsw-alias-bg-overlay`).

The host half (`lib/index.js`) is a no-op — the row exists so the package
mounts and the `dsh.client` declaration is discovered by dsh-client-modules.