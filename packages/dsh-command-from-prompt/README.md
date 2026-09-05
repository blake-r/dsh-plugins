# @blake-r/dsh-command-from-prompt

Generic 'command = user prompt' slash-command plugin.

A bundle package in the dsh-plugins monorepo. It defines no commands by default
— commands are registered from the user's profile via `cordis.patch.yml` `insert`
entries (e.g. `commit`, `status`). See the profile's `cordis.patch.yml` for an
example configuration.

## Install

From npm (published):

```bash
dsh plugin --profile web add @blake-r/dsh-command-from-prompt
```

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-command-from-prompt
```
