# @blake-r/dsh-command-from-prompt

Generic 'command = user prompt' slash-command plugin.

A bundle package in the dsh-plugins monorepo. It defines no commands by default
— commands are registered from the user's profile via `cordis.patch.yml` `insert`
entries (e.g. `commit`, `status`). See the profile's `cordis.patch.yml` for an
example configuration.

Every registered command accepts an optional trailing text: `input: { hint }` is
declared on each definition, so picking the command from the GUI slash menu
inserts `/name ` into the composer (the hint shows as the placeholder) instead
of sending the command immediately. When the submitted line carries trailing
text, it is appended to the command's `prompt` (separated by a blank line) in
the message sent to the model.

## Config shape

```yaml
config:
  <name>:
    description: <short help shown in the command list>
    prompt: <user-message text sent to the model>
    hint: <placeholder shown in the composer after picking the command>
```

`hint` is optional and defaults to `optional text`.

## Install

From npm (published):

```bash
dsh plugin --profile web add @blake-r/dsh-command-from-prompt
```

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-command-from-prompt
```