# dsh-plugins

Monorepo of plugins for **DeepSeek Harness (dsh)**. Each plugin is a separate
npm package with a `dsh.bundle.patch` manifest, so plugins can be installed
**selectively** from a single repository and are **automatically** added to the
profile (no manual `cordis.patch.yml` editing).

## Structure

```
dsh-plugins/
├── package.json          # root: workspaces, private
├── pnpm-workspace.yaml
├── scripts/check.mjs     # node --check over all src/*
└── packages/
    ├── dsh-plugin-a/     # @blake-r/dsh-plugin-a
    └── dsh-plugin-b/     # @blake-r/dsh-plugin-b
```

## Plugins

| Package | What it does |
| --- | --- |
| [dsh-assembly-plan-compacter](packages/dsh-assembly-plan-compacter/README.md) | Make `plan_mode` print the full plan and `exit_plan_mode` carry a brief summary. |
| [dsh-assembly-tools-prompt-strip](packages/dsh-assembly-tools-prompt-strip/README.md) | Drop the `tool:<name>` prose guidance sections from the system prompt. |
| [dsh-command-from-prompt](packages/dsh-command-from-prompt/README.md) | Generic "command = user prompt" slash-command plugin. |
| [dsh-compaction-micro](packages/dsh-compaction-micro/README.md) | Per-request trajectory re-composition for the kb preset. |
| [dsh-provider-websearch-lightpanda](packages/dsh-provider-websearch-lightpanda/README.md) | WebRuntime provider pair backed by the lightpanda MCP server. |
| [dsh-skill-from-tools](packages/dsh-skill-from-tools/README.md) | One skill per tool (no module grouping), short form. |
| [dsh-tool-filter-root-find](packages/dsh-tool-filter-root-find/README.md) | Gates tool calls that sweep the whole disk or home directory. |
| [dsh-tool-trajectory-recall](packages/dsh-tool-trajectory-recall/README.md) | Model-facing same-session recall/search tools over the durable session log. |

## How it works

Each package declares in `package.json`:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

and ships a `cordis.patch.yml` file (a YAML list of rows with `insert`).
The `dsh plugin --profile web add <pkg>` command installs the package and, via
`reconcilePlugins`, **itself** adds it to `dsh.profile.bundles` — the plugin is
activated without manual edits.

## Install (selective, local)

```bash
cd <dsh-checkout>
dsh plugin --profile web add ./packages/dsh-plugin-a
# only dsh-plugin-a; dsh-plugin-b is not installed
```

`pnpm add ./path` creates a symlink to the local folder — convenient for development.

## Install (external users)

```bash
# from the npm registry (recommended for selectivity from one repo)
dsh plugin --profile web add @blake-r/dsh-plugin-a

# from a GitHub repository, a single plugin subdirectory (tag = version)
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-plugin-a

# from a GitHub repository, the whole repo root (tag = version)
dsh plugin --profile web add github:blake-r/dsh-plugins#v1.0.0
```

> **About `github:`:** the `github:` protocol installs the repository root by
> default. To install a single plugin from this monorepo, point at its
> subdirectory with `#path:packages/<name>` (as shown above). For the most
> selective install from one repo, publish the packages to npm
> (`pnpm -r publish`) and install by name.

## Publishing

```bash
pnpm install
pnpm check        # node --check over all src/*
pnpm -r publish   # publish all packages to npm
```

npm versions should match git tags `vX.Y.Z`.

## Adding a new plugin

1. Copy `packages/dsh-plugin-a` → `packages/dsh-plugin-<name>`.
2. Change `name` (scope `@blake-r/dsh-<name>`), `version`, `description`.
3. Write the logic in `src/index.js` (ESM, export `name` + `apply(ctx)`).
4. Update `cordis.patch.yml` (row id and name).
5. `pnpm check` and `pnpm -r publish`.

## Notes

- Plugin files are ESM (`.mjs`); check with `node --check`.
- The package's `cordis.patch.yml` must be in `files` (otherwise it won't be published).
