// dsh-assembly-rewrite — rewrite exactly one named system-prompt assembly insert from config.
//
// Each plugin row patches exactly ONE assembly value: the insert addressed by
// the (namespace, name) pair in this row's `config`. To rewrite several values,
// add several rows with distinct ids, each with its own config. No code changes
// are needed to add or tweak an override.
//
// Config shape (see the profile's shared.cordis.yml):
//   config:
//     namespace: tools | sections | contexts | variables
//     name: <insert name>
//     ...namespace-specific payload...
//
// tools — rewrite the tool named `name`:
//   description: <replacement tool description>
//   parameters:
//     <paramName>:
//       description: <replacement parameter description>
//
// sections — overwrite the section named `name`, or insert it as a NEW section
// when it does not exist yet:
//   text: <replacement section text>
//   before: <existingSectionName>   # insert a NEW section before this anchor
//   after: <existingSectionName>    # insert a NEW section after this anchor
//
// contexts — rewrite the context named `name`:
//   text: <replacement context text>
//
// variables — rewrite the variable named `name`:
//   value: <replacement string value>
//
// A configured insert that is not present in the assembled prompt is silently
// skipped. Sections: an existing section is overwritten in place and never
// duplicated; a missing one is inserted before/after the named anchor via
// `before`/`after`, or appended at the end when no anchor is given (or the
// anchor is missing). `before` wins over `after`.
//
// Ordering: the listener is registered with `{ prepend: true }`, so it runs
// FIRST in the waterfall regardless of where this row sits in the profile's
// insert list. This matters for `dsh-skill-from-tools`, which captures tool
// descriptions into skill bodies: a rewritten description must be applied
// before that plugin reads it. `ctx.on` with `prepend` unshifts the listener
// onto the hook list, and the waterfall dispatches hooks in order.

const name = "dsh-assembly-rewrite";
const inject = ["systemPrompt"];

function apply(ctx, config) {
  const cfg = config ?? {};
  const namespace = cfg.namespace;
  const target = cfg.name;

  ctx.on(
    "system-prompt/assemble",
    (assembly, context, next) => {
      switch (namespace) {
        case "tools": {
          const tool = assembly.tools?.find((t) => t.name === target);
          if (!tool) break;
          if (typeof cfg.description === "string") {
            tool.description = cfg.description;
          }
          for (const [param, pdef] of Object.entries(cfg.parameters ?? {})) {
            const p = tool.parameters?.[param];
            if (p && pdef && typeof pdef.description === "string") {
              p.description = pdef.description;
            }
          }
          break;
        }
        case "sections": {
          if (typeof cfg.text !== "string") break;
          const list = assembly.sections ?? [];
          // Idempotent: remove ALL existing copies of the target name, then
          // insert one copy at the configured position, so the final state is
          // the same no matter how many times assemble() runs.
          const filtered = list.filter((s) => s.name !== target);
          const anchor = typeof cfg.before === "string" ? cfg.before : typeof cfg.after === "string" ? cfg.after : null;
          const idx = anchor === null ? -1 : filtered.findIndex((s) => s.name === anchor);
          const entry = { name: target, text: cfg.text };
          if (idx < 0) {
            filtered.push(entry);
          } else if (typeof cfg.before === "string") {
            filtered.splice(idx, 0, entry);
          } else {
            filtered.splice(idx + 1, 0, entry);
          }
          assembly.sections = filtered;
          break;
        }
        case "contexts": {
          const c = assembly.contexts?.find((x) => x.name === target);
          if (c && typeof cfg.text === "string") {
            c.text = cfg.text;
          }
          break;
        }
        case "variables": {
          if (typeof cfg.value === "string") {
            assembly.variables[target] = cfg.value;
          }
          break;
        }
      }
      return next();
    },
    { prepend: true }
  );
}

export { apply, inject, name };