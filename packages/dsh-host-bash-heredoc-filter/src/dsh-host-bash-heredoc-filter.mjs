// dsh-host-bash-heredoc-filter — forbid HEREDOC (<<EOF) in bash commands.
//
// Policy: any bash call whose `command` argument contains a classic heredoc is
// denied BEFORE dispatch. The handler never runs; the model receives
// `Error: <reason>` with a hint to write the file with the `write` tool and
// execute the command separately.
//
// Matched forms (classic heredocs only):
//   <<WORD   <<-WORD   <<'WORD'   <<"WORD"   <<\WORD
// (whitespace between the operator and the delimiter is allowed).
// Not matched: here-strings (`<<<`), arithmetic shifts (`1<<2`), and literal
// `<<word` inside quoted strings or comments — the scanner tracks quote and
// comment state instead of a naive regex.
//
// The plugin also injects a short rule section into the assembled system
// prompt so the model avoids heredocs in the first place.
//
// Host-plane plugin: an untagged listener on `tools/pre-execute` sees calls
// from every agent (main session, subagents, ralph), so the policy applies
// everywhere. `{ prepend: true }` makes the deny decision first in the
// waterfall.

export const name = "dsh-host-bash-heredoc-filter";
export const inject = ["tools", "systemPrompt"];

const DENY_REASON =
  "Blocked: HEREDOC (<<EOF) in bash is forbidden. Write the file with the write tool, then execute the command separately.";

const PROMPT_RULE =
  "Do not use HEREDOC (<<EOF) in bash commands. To create files, use the write tool, then execute the command separately.";

const PROMPT_SECTION = "bash-heredoc-policy";

/**
 * True when `command` contains a classic heredoc operator outside quoted
 * strings and comments. Pure function — exported for unit tests.
 */
export function hasHeredoc(command) {
  if (typeof command !== "string") return false;
  const n = command.length;
  let i = 0;
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return false; // unterminated quote: the rest is literal
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (command[i] === "\\") i += 2;
        else if (command[i] === '"') {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      // comment runs to the end of the line
      const nl = command.indexOf("\n", i);
      if (nl < 0) return false;
      i = nl + 1;
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      let j = i + 2;
      if (command[j] === "-") j += 1;
      while (j < n && /\s/.test(command[j])) j += 1;
      if (j >= n) return false;
      const d = command[j];
      if (d === "'" || d === '"') {
        const end = command.indexOf(d, j + 1);
        if (end > j) return true;
        i = j + 1;
        continue;
      }
      if (d === "\\") j += 1;
      if (j < n && /[A-Za-z_]/.test(command[j])) return true;
      i = j;
      continue;
    }
    i += 1;
  }
  return false;
}

function apply(ctx) {
  ctx.on(
    "tools/pre-execute",
    async (exec, next) => {
      if (exec.name === "bash" && hasHeredoc(exec.arguments?.command)) {
        return { kind: "deny", reason: DENY_REASON };
      }
      return next();
    },
    { prepend: true }
  );

  ctx.on(
    "system-prompt/assemble",
    (assembly, context, next) => {
      const list = assembly.sections ?? [];
      const filtered = list.filter((s) => s.name !== PROMPT_SECTION);
      filtered.push({ name: PROMPT_SECTION, text: PROMPT_RULE });
      assembly.sections = filtered;
      return next();
    },
    { prepend: true }
  );
}

export { apply };