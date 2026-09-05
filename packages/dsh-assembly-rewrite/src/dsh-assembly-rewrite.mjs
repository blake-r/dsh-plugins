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
//         before: <existingSectionName>   # insert a NEW section before this anchor
//         after: <existingSectionName>    # insert a NEW section after this anchor
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
// Sections: a `sections.<name>` entry whose name already exists overwrites that
// section's text in place. A name that does NOT exist inserts a NEW section —
// positioned before/after the named anchor section via `before`/`after`, or at
// the end of the section list when no anchor is given (or the anchor is
// missing). `before` wins over `after`; an existing section is never duplicated.
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

      // sections: { <sectionName>: { text, before?, after?, at? } }
      //
      // Idempotent insert: first removes ALL existing sections with the target
      // name, then inserts one copy at the configured position. This ensures
      // the same final state regardless of how many times assemble() runs.
      //
      // Positioning:
      //   - `before: <name>` — insert before the named anchor
      //   - `after: <name>`  — insert after the named anchor (default)
      //   - no anchor        — append at the end
      //
      // `before` wins over `after`; a missing anchor falls back to appending
      // so the block still lands in the prompt.
      for (const [secName, def] of Object.entries(cfg.sections ?? {})) {
        if (!def || typeof def !== "object") continue;
        if (typeof def.text !== "string") continue;
        const list = assembly.sections ?? [];

        // Step 1: remove ALL existing copies of this section name
        const beforeCount = list.length;
        const filtered = list.filter((s) => s.name !== secName);
        const removed = beforeCount - filtered.length;

        // Step 2: determine anchor and insert position
        const anchor = typeof def.before === "string" ? def.before : typeof def.after === "string" ? def.after : null;
        const idx = anchor === null ? -1 : filtered.findIndex((s) => s.name === anchor);

        const newEntry = { name: secName, text: def.text };

        if (idx < 0) {
          // No anchor found (or none given): append
          filtered.push(newEntry);
        } else if (typeof def.before === "string") {
          filtered.splice(idx, 0, newEntry);
        } else {
          filtered.splice(idx + 1, 0, newEntry);
        }

        // Step 3: replace the list (avoids in-place mutation surprises)
        assembly.sections = filtered;
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