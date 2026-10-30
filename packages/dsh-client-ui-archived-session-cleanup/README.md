# @blake-r/dsh-client-ui-archived-session-cleanup

DSH web UI plugin: a Settings control to delete archived sessions older than N
days, with a live preview of what would be removed.

The package carries both halves of the plugin:

- **Host half** (`lib/index.js`) — registers the `archivedSessionCleanup`
  remote service (`previewOlderThan`, `stats`, `deleteOlderThan`). It walks the
  workspace registry's archived session set and, for each archived session
  older than `days` days, removes the session directory from disk, detaches the
  session from its accounting workspace, and drops it from the registry's
  archive set. Sessions that are currently attached/running are skipped.
- **Browser half** (`lib/client.js`) — registers a `settings.section` entry
  whose component renders a number field (days) and a Delete button, with a
  debounced live preview. It reaches the host service through the client's
  `ctx.remote` (`archivedSessionCleanup/` endpoints).

The browser half is discovered automatically: the package.json `dsh.client`
declaration (`platform: web`) plus the `./client` export are picked up by
`@deepseek-ai/dsh-client-modules` and composed into the client graph.

## Install

```bash
dsh plugin --profile web add @blake-r/dsh-client-ui-archived-session-cleanup
```

The bundle patch inserts the single plugin row `archived-session-cleanup`
whose `name` resolves to this package. The profile's `cordis.patch.yml` may
override the row by id (e.g. to tweak defaults); the row's `name` must keep
pointing at this package so both halves stay wired.