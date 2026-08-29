// dsh-skill-from-tools — one skill per tool (no module grouping). Every
// non-`skill` tool becomes its own skill whose description AND content use the
// SHORT form: first sentence of the original description + the parameter schema
// rendered as a COMPACT JSON literal (no descriptions, no `Requires` /
// `Optionally` words). The full `parameters` schema stays in the tool registry;
// only the compact JSON line is rendered.
//
// COMPACT SCHEMA NOTATION (per user spec):
//   - required field:  `"command":string`
//   - optional field:  `"command":undef|string`   (`undef` = may be absent)
//   - nested object:   `{"questions":[{"id":string,"header":undef|string}]}`
//   - array:           `[<item type>]`
//   - enum:            `"edit"|"pause"|"resume"|"complete"|"blocked"`
//   - const:           `"new"`
//   - oneOf union:     `integer|null` (nullable) or `{...}|{...}` (discriminated)
//   - `null` is a VALID value (distinct from `undef` absence); `json`/empty
//     schemas collapse to `any`.
//
// CRITICAL: skill ids MUST be valid per the grammar `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
// Registering with `name: tool.name` (e.g. `todo_write`, `exit_plan_mode`,
// `ask_user_question`) — which contain underscores — throws `invalid skill
// name`, and the exception thrown inside the `system-prompt/assemble` waterfall
// listener aborts the WHOLE waterfall → NO skills registered at all (empty
// catalog, "skills disappeared"). Fix: EVERY skill gets a `t<hex><initials>` id;
// the real tool name lives only in the `description`. Never use a raw tool name
// as a skill id — always route through the `t<hex><initials>` scheme.
//
// SCOPE: this plugin ONLY moves tools out of the LLM context into skills. It
// does NOT touch the `tool:*` prose sections — cleaning those out of the system
// prompt is a separate concern (see the profile's cordis.patch.yml).
// Keeping the two concerns separate means each plugin has a single
// responsibility.
//
// DISAMBIGUATION: the word "tool" is ambiguous — a model that reads a skill may
// try to route the call through the `mcp` gateway. Every skill therefore states
// explicitly (in both the catalog description and the content block) that the
// tool is invoked as a direct `tool_call` with its own name, NOT via `mcp`.
const name = "dsh-skill-from-tools";
const inject = ["skills", "systemPrompt", "tools"];
// The `skill` loader stays in the prompt; every other tool is hidden.
const EXCLUDED = new Set(["skill"]);

// Lowercased first letters of each word of a name (camelCase + separators).
function initials(nameStr) {
  const words = nameStr
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words.map((w) => w[0].toLowerCase()).join("");
}

// Compact type string for one compiled JSON-Schema node.
function typeStr(node) {
  if (node === undefined || node === null) return "any";
  if (node.const !== undefined) return `"${String(node.const)}"`;
  if (node.enum !== undefined) return node.enum.map((v) => `"${String(v)}"`).join("|");
  if (Array.isArray(node.oneOf)) return node.oneOf.map(typeStr).join("|");
  if (node.type === "object" && node.properties) return objStr(node);
  if (node.type === "array" && node.items) return `[${typeStr(node.items)}]`;
  if (typeof node.type === "string") return node.type;
  if (node.items !== undefined) return `[${typeStr(node.items)}]`;
  return "any";
}

// Compact object literal for a compiled `{type:"object",properties,required}`.
function objStr(node) {
  const props = node.properties ?? {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const parts = Object.keys(props).map((key) => {
    const p = props[key];
    const t = typeStr(p);
    // const (literal) fields render as the bare literal — no `undef|` prefix,
    // even when not marked required (e.g. `kind:"new"` inside a oneOf branch).
    if (p && p.const !== undefined) return `"${key}":${t}`;
    return `"${key}":${required.has(key) ? t : `undef|${t}`}`;
  });
  return `{${parts.join(",")}}`;
}

// Compact JSON schema line for a tool's parameters; '' when none.
function schemaJson(parameters) {
  if (parameters === undefined || parameters === null || typeof parameters !== "object") return "";
  return objStr(parameters);
}

// First sentence of a description; '' when empty.
function firstSentence(text) {
  if (typeof text !== "string") return "";
  const t = text.replaceAll(/\s+/g, " ").trim();
  if (t.length === 0) return "";
  const m = t.match(/^.*?[.!?](?:\s|$)/);
  return m ? m[0].trim() : t;
}

// Short description line for a tool: first sentence + compact JSON schema.
function shortLine(tool) {
  const desc = firstSentence(tool.description);
  const schema = schemaJson(tool.parameters);
  return [desc, schema].filter(Boolean).join(" ");
}

// Short content block for one tool: `## \`<tool>\` tool` + an explicit
// "invoke via tool_call" note + the short description line. (Prose guidance is
// NOT folded here.)
//
// DISAMBIGUATION: the bare word "tool" is ambiguous — a model that reads the
// skill may try to route the call through the `mcp` gateway instead of calling
// the tool directly. The explicit note below pins the mechanism: the tool is
// invoked as a direct `tool_call` with its own name, NOT via the `mcp` tool.
function toolBlock(tool) {
  return [
    `## \`${tool.name}\` tool`,
    `Invoke directly as a tool_call named \`${tool.name}\` — do NOT route through the \`mcp\` gateway.`,
    shortLine(tool)
  ].join("\n").trim();
}

function apply(ctx) {
  const registered = new Set(); // skill ids already registered this agent
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const tools = Array.isArray(assembly?.tools) ? assembly.tools : [];
    const all = tools.filter(
      (tool) => tool !== null && typeof tool === "object" && typeof tool.name === "string" && !EXCLUDED.has(tool.name)
    );
    const hexWidth = Math.max(1, (all.length - 1).toString(16).length);
    let index = 0;
    for (const tool of all) {
      const skillName = `t${index.toString(16).padStart(hexWidth, "0")}${initials(tool.name)}`;
      if (registered.has(skillName)) { index++; continue; }
      const desc = firstSentence(tool.description);
      const schema = schemaJson(tool.parameters);
      const lower = desc.length > 0 ? desc[0].toLowerCase() + desc.slice(1) : desc;
      const catalogDesc = `Skill details about tool_call \`${tool.name}\` to ${lower} — invoke it directly as a tool_call, not via the \`mcp\` gateway`.trim();
      const full = [catalogDesc, schema].filter(Boolean).join(" ");
      const content = toolBlock(tool);
      if (content.length === 0) { index++; continue; }
      ctx.skills.register({
        name: skillName,
        description: full,
        whenToUse: `When the model intends to call the "${tool.name}" tool (this skill is "${skillName}").`,
        content,
        invocation: { modelInvocable: true, userInvocable: false },
        source: `dsh-skill-from-tools:${tool.name}`
      });
      registered.add(skillName);
      index++;
    }
    // Authoritative: only `skill` stays in the LLM request's tools array.
    assembly.tools = tools.filter((tool) => tool === null || typeof tool !== "object" || typeof tool.name === "string" && EXCLUDED.has(tool.name));
    // NOTE: `tool:*` prose sections are NOT filtered here.
    return next();
  });
}

export { apply, inject, name };
