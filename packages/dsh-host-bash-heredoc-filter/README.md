# dsh-host-bash-heredoc-filter

Forbid HEREDOC (`<<EOF`) in bash commands.

## Policy

Any bash tool call whose `command` argument contains a classic heredoc is
denied **before dispatch** — the handler never runs. The model receives
`Error: Blocked: HEREDOC (<<EOF) in bash is forbidden. Write the file with
the write tool, then execute the command separately.`

Matched forms: `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`
(whitespace between the operator and the delimiter allowed).

Not matched: here-strings (`<<<`), arithmetic shifts (`1<<2`), and literal
`<<word` inside quoted strings or comments.

The plugin also injects a short rule section (`bash-heredoc-policy`) into the
assembled system prompt so the model avoids heredocs in the first place.

## Scope

Host-plane plugin: an untagged listener on `tools/pre-execute` sees calls
from every agent (main session, subagents, ralph), so the policy applies
everywhere.

## Mount

Web profile `cordis.patch.yml` (host plane):

```yaml
- id: dsh-host-bash-heredoc-filter
  name: '@blake-r/dsh-host-bash-heredoc-filter'
```

Plus the `link:` dependency in `home/profiles/web/package.json`:

```json
"@blake-r/dsh-host-bash-heredoc-filter": "link:../../../plugins/dsh-plugins/packages/dsh-host-bash-heredoc-filter"
```

## Test

```sh
node --check src/dsh-host-bash-heredoc-filter.mjs
```