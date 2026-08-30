// dsh-assembly-rewrite — rewrite named system-prompt assembly inserts from config.
//
// A generic, config-driven plugin for the web profile. It reads a map of
// overrides from this row's `config` and, in the `system-prompt/assemble`
// waterfall, rewrites any named insert whose name appears in the config —
// across all four assembly namespaces: `tools`, `sections`, `contexts`, and
// `variables`. No code changes are needed to add or tweak an override.
//
// Config shape (see the profile's cordis.patch.yml):
//   config:
//     tools:
//       <toolName>:
//         description: <replacement tool description>
//         parameters:
//           <paramName>:
//             description: <replacement parameter description>
//     sections:
//       <sectionName>:
//         text: <replacement section text>
//     contexts:
//       <contextName>:
//         text: <replacement context text>
//     variables:
//       <variableName>: <replacement string value>
//
// A config key addresses an insert ONLY within its own namespace: `tools.foo`
// rewrites the tool named `foo`, `sections.foo` the section named `foo`, and
// so on. Names may collide across namespaces (a skill and a tool can both be
// called `foo`) — the key is the (namespace, name) pair, so there is no
// conflict. If a configured name is not present in the assembled prompt, that
// entry is silently skipped.
//
// Ordering: the listener is registered with `{ prepend: true }`, so it runs
// FIRST in the waterfall regardless of where this row sits in the profile's
// insert list. This matters for `dsh-skill-from-tools`, which captures tool
// descriptions into skill bodies: a rewritten description must be applied
// before that plugin reads it. `ctx.on` with `prepend` unshifts the listener
// onto the hook list, and the waterfall dispatches hooks in order.
//
// The default config in the web profile preserves the former
// `dsh-assembly-plan-compacter` behavior: it rewrites the `exit_plan_mode`
// tool description (including the "Chat about it" reframe) so plan mode prints
// the full plan and `exit_plan_mode` carries only a brief summary.

const name = "dsh-assembly-rewrite";
const inject = ["systemPrompt"];

function apply(ctx, config) {
  const cfg = config ?? {};

  ctx.on(
    "system-prompt/assemble",
    (assembly, context, next) => {
      // tools: { <toolName>: { description?, parameters?: { <param>: { description? } } } }
      for (const [toolName, def] of Object.entries(cfg.tools ?? {})) {
        if (!def || typeof def !== "object") continue;
        const tool = assembly.tools?.find((t) => t.name === toolName);
        if (!tool) continue;
        if (typeof def.description === "string") {
          tool.description = def.description;
        }
        for (const [param, pdef] of Object.entries(def.parameters ?? {})) {
          const p = tool.parameters?.[param];
          if (p && pdef && typeof pdef.description === "string") {
            p.description = pdef.description;
          }
        }
      }

      // sections: { <sectionName>: { text } }
      for (const [secName, def] of Object.entries(cfg.sections ?? {})) {
        if (!def || typeof def !== "object") continue;
        const sec = assembly.sections?.find((s) => s.name === secName);
        if (sec && typeof def.text === "string") {
          sec.text = def.text;
        }
      }

      // contexts: { <contextName>: { text } }
      for (const [ctxName, def] of Object.entries(cfg.contexts ?? {})) {
        if (!def || typeof def !== "object") continue;
        const c = assembly.contexts?.find((x) => x.name === ctxName);
        if (c && typeof def.text === "string") {
          c.text = def.text;
        }
      }

      // variables: { <variableName>: <string> }
      for (const [varName, value] of Object.entries(cfg.variables ?? {})) {
        if (typeof value === "string") {
          assembly.variables[varName] = value;
        }
      }

      return next();
    },
    { prepend: true }
  );
}

export { apply, inject, name };