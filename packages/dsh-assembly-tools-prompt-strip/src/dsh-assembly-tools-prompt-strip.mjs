// dsh-assembly-tools-prompt-strip — drop the `tool:<name>` prose guidance sections from
// the system prompt. Their text is no longer needed inline (tools now carry
// short descriptions in the tools layer; full guidance lives elsewhere if
// desired).
//
// The `tool:*` sections are separate prompt sections named `tool:<name>`
// registered at `order: 100` by each tool plugin (e.g. `dsh-tool-fs/lib/index.js`
// registers `tool:read` with text "Use the read tool — not shell commands like
// cat — ..."). They land in `assembly.sections` (the `system-prompt/assemble`
// waterfall receives `{sections, contexts, tools, variables}` —
// dsh-system-prompt/lib/index.js:267-282). This listener filters
// `assembly.sections` to drop every `tool:*` section. `tool:skill` does not
// exist, so the skill-loader catalog guidance is untouched.
//
// SCOPE: this plugin ONLY cleans the `tool:*` prose sections out of the system
// prompt. Keeping this concern separate means each plugin has a single
// responsibility. Injected via `["systemPrompt"]`, mounted AFTER
// `tools-as-skills` in the profile's cordis.patch.yml.
const name = "dsh-assembly-tools-prompt-strip";
const inject = ["systemPrompt"];

function apply(ctx) {
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    if (Array.isArray(assembly.sections)) {
      assembly.sections = assembly.sections.filter(
        (section) => !(typeof section?.name === "string" && section.name.startsWith("tool:"))
      );
    }
    return next();
  });
}

export { apply, inject, name };
