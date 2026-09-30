// dsh-skill-from-tools — one skill per tool (no module grouping). Every
// non-`skill` tool becomes its own skill. The skill `description` carries the
// SHORT form: first sentence + the parameter schema as a COMPACT literal in the
// `/`-marked notation below. The skill `content` carries the tool's MINIFIED
// JSON SCHEMA, dumped verbatim from the tool registry.
//
// COMPACT SCHEMA NOTATION (per user spec):
//   - field with a type:   `"command":/string/` — the `/.../` marker is always
//     present, on every field, including one whose type is a whole container,
//     so no bare type name is ever left unmarked.
//   - optional field:      `"description":/undef|string/` (`undef` = may be
//     absent; rendered inside the marker, in front of the type)
//   - const field:         `"kind":/"new"/` — a const literal keeps its double
//     quotes and takes no `undef|` prefix (a fixed value, not an optional
//     slot), even when the field is not listed as required.
//   - enum:                `"action":/"edit"|"pause|resume"/` — literal values
//     are double-quoted, so a value can never collide with the `/` marker.
//   - nested object:       `"questions":/{"id":/string/,"header":/undef|string/}/`
//     — containers stay structural inside the marker, and their fields carry
//     their own markers.
//   - array:               `"options":/undef|[{"label":/string/}]/` — the item
//     expression is not itself marked: brackets already mark the position.
//   - oneOf union:         `"mode":/"new"|string/` (literal beside a type),
//     `"branch":/undef|{"kind":/"a"/}|{"kind":/"b"/}/` (discriminated),
//     `"cursor":/string|null/` (nullable).
//   - `null` is a VALID value (distinct from `undef` absence) and is never
//     folded into `undef`; requiredness is carried by the `undef|` prefix
//     alone. `json`/empty schemas collapse to `any`.
//   - a type ARRAY (`type: ["string","null"]`) is legal JSON Schema but can
//     only reach this plugin through a raw `register()`: an MCP server's
//     `inputSchema` is registered unchanged (`@deepseek-ai/dsh-mcp-client`
//     passes it through), while the harness subset rejects `type` arrays for
//     authored tools (`@deepseek-ai/dsh-tools`: "type must be a single type
//     string"). Such a node renders as the union of its names, with an `array`
//     branch expanded through `items`: `["string","array"]` + `items:string`
//     becomes `string|[string]`.
//
// CONTENT FORM: the content block carries the parameters as MINIFIED JSON
// SCHEMA (`JSON.stringify`), not a hand-written annotated rendering. JSON is
// the format every model already reads, and a serializer cannot lose or
// misreport a node the way a custom renderer can — the `type: [...]` collapse
// above is exactly that class of bug. The explicit `Arguments (JSON Schema):`
// label names the dialect, so the line is not mistaken for prose. The catalog
// line stays compact because it is the only part always in context; the
// content block is read on demand, when the model opens the skill.
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
// folds each tool's `tool:<name>` prose guidance section (from the assembly)
// into the skill's content block, but does NOT strip those sections out of the
// system prompt — cleaning them out is a separate concern (see the profile's
// cordis.patch.yml). Keeping the two concerns separate means each plugin has a
// single responsibility.
//
// REALM / SCOPE: this plugin is a HOST plugin (mounted in the profile's bundle
// list), so its `system-prompt/assemble` listener is registered on the
// unscoped host context and fires for EVERY agent in EVERY dialog. Skills must
// therefore be registered through the AGENT's own scoped context
// (`context.agent.ctx`), not the plugin's host `ctx`. `skills.register()` files
// into the layer of `scopeOf(this.ctx)`: registering through the host ctx puts
// every skill in the GLOBAL layer, which the skill registry merges into every
// agent's catalog — so one dialog's tools leak into all other dialogs. Routing
// through `context.agent.ctx` lands each skill in that agent's scope layer
// (visible only to it) and ties its lifecycle to the agent (unregistered when
// the agent is disposed). The "already registered" set must likewise be keyed
// per agent, not shared, or a later agent would skip skills a previous agent
// already registered.
//
// IMPORTANT: reach the skills service on the agent's scoped context via
// `agentCtx.get("skills")`, NOT `agentCtx.skills`. The property form throws
// "cannot get property skills without inject" because the agent's scoped
// context does not declare `skills` injection. `get()` reads the service from
// the store without the inject requirement and returns a traceable proxy bound
// to `agentCtx`, so `register()` sees `this.ctx = agentCtx` and files into
// `scopeOf(agentCtx)` = that agent's layer. (An `isolate` realm in the
// composition is a different mechanism — it isolates services a `cordis:group`
// PUBLISHES; this plugin publishes no service, so no realm is needed.)
//
// DISAMBIGUATION: the word "tool" is ambiguous — a model that reads a skill may
// not know how to invoke it. The content block therefore states explicitly that
// the tool is invoked as a direct `tool_call` with its own name. We deliberately
// do NOT add a "not via mcp" note: it is redundant noise repeated across all
// skills. The skill id and description already name the tool.
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

// Type expression for one schema node: atoms joined by `|`, containers kept
// structural, literals double-quoted. Carries no `/.../` marker and no `undef|`
// prefix — those belong to the field rendering in `fieldBody`.
function typeExpr(node) {
  if (node === undefined || node === null) return "any";
  if (node.const !== undefined) return `"${String(node.const)}"`;
  if (node.enum !== undefined) return node.enum.map((v) => `"${String(v)}"`).join("|");
  if (Array.isArray(node.oneOf)) return node.oneOf.map(typeExpr).join("|");
  if (node.type === "object" && node.properties) return compactFields(node);
  if (node.type === "array" && node.items) return `[${typeExpr(node.items)}]`;
  if (Array.isArray(node.type)) {
    return node.type
      .map((t) => (t === "array" && node.items !== undefined ? `[${typeExpr(node.items)}]` : String(t)))
      .join("|");
  }
  if (typeof node.type === "string") return node.type;
  if (node.items !== undefined) return `[${typeExpr(node.items)}]`;
  return "any";
}

// One field's marked body: optional fields get `undef|` in front of the type,
// const fields never do (a const is a fixed value).
function fieldBody(node, isRequired) {
  const t = typeExpr(node);
  if (node !== null && typeof node === "object" && node.const !== undefined) return t;
  return isRequired ? t : `undef|${t}`;
}

// Compact object literal for a compiled `{type:"object",properties,required}`:
// every field is `"key":/type/`, the marker is never omitted.
function compactFields(node) {
  const props = node.properties ?? {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const parts = Object.keys(props).map((key) => `"${key}":/${fieldBody(props[key], required.has(key))}/`);
  return `{${parts.join(",")}}`;
}

// Compact schema literal for a tool's parameters; '' when there are none.
function compactSchema(parameters) {
  if (parameters === undefined || parameters === null || typeof parameters !== "object") return "";
  return compactFields(parameters);
}

// Minified JSON Schema for a tool's parameters, verbatim from the registry;
// '' when there are none.
function schemaDump(parameters) {
  if (parameters === undefined || parameters === null || typeof parameters !== "object") return "";
  return JSON.stringify(parameters);
}

// First sentence of a description; '' when empty.
function firstSentence(text) {
  if (typeof text !== "string") return "";
  const t = text.replaceAll(/\s+/g, " ").trim();
  if (t.length === 0) return "";
  const m = t.match(/^.*?[.!?](?:\s|$)/);
  return m ? m[0].trim() : t;
}

// Full content block for one tool: `## \`<tool>\` tool` + an explicit "invoke as
// a tool_call" note + the FULL description + the `tool:<name>` prose guidance
// section from the assembly (when present) + the tool's MINIFIED JSON SCHEMA
// under an explicit `Arguments (JSON Schema):` label. The catalog `description`
// keeps only the first sentence and the compact literal; the content block
// carries the complete description, the full prose guidance, and the schema.
//
// ARGUMENTS LABEL: without it the schema line would follow prose that may
// itself mention fields, leaving no marker for where the parameter schema
// begins, and a bare JSON line would read as one more prose sentence. The label
// also names the dialect, and it is omitted only when the tool takes no
// parameters (the catalog `description` still says `Arguments: {}` there).
//
// DISAMBIGUATION: the bare word "tool" is ambiguous — a model that reads the
// skill may not know how to invoke it. The explicit note below pins the
// mechanism: the tool is invoked as a direct `tool_call` with its own name.
function toolBlock(tool, schemaText, proseText) {
  const desc = typeof tool.description === "string" ? tool.description.replaceAll(/\s+/g, " ").trim() : "";
  return [
    `## \`${tool.name}\` tool`,
    `Invoke directly as a tool_call named \`${tool.name}\`.`,
    desc,
    proseText,
    schemaText ? `Arguments (JSON Schema): ${schemaText}` : ""
  ].filter(Boolean).join("\n").trim();
}

function apply(ctx) {
  // Per-agent skill-id tracking. The host listener fires for every agent, so
  // the "already registered" set must be keyed by the agent scope — a single
  // shared set would make a later agent skip skills an earlier agent already
  // registered. WeakMap lets the entry be collected with the agent object.
  const registeredByAgent = new WeakMap();
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const tools = Array.isArray(assembly?.tools) ? assembly.tools : [];
    // Map `tool:<name>` prose guidance sections (registered at `order: 100` by
    // each tool plugin) by tool name so each skill can fold its full prose into
    // its content block. Sections are `{name, text}`; only exact `tool:<name>`
    // matches are used.
    const proseByTool = new Map();
    if (Array.isArray(assembly?.sections)) {
      for (const section of assembly.sections) {
        if (typeof section?.name === "string" && section.name.startsWith("tool:") && typeof section.text === "string") {
          proseByTool.set(section.name.slice("tool:".length), section.text);
        }
      }
    }
    const all = tools.filter(
      (tool) => tool !== null && typeof tool === "object" && typeof tool.name === "string" && !EXCLUDED.has(tool.name)
    );
    // Register through the agent's own scoped context so skills land in that
    // agent's scope layer (visible only to it) and are unregistered when the
    // agent is disposed. `context.agent` is always set by the agent loop's
    // `assembleContextFor`; the fallback below is only a safety net.
    const agent = context?.agent;
    const agentCtx = agent?.ctx;
    let registered;
    if (agentCtx !== undefined) {
      registered = registeredByAgent.get(agent);
      if (registered === undefined) {
        registered = new Set();
        registeredByAgent.set(agent, registered);
      }
    }
    const hexWidth = Math.max(1, (all.length - 1).toString(16).length);
    let index = 0;
    for (const tool of all) {
      const skillName = `t${index.toString(16).padStart(hexWidth, "0")}${initials(tool.name)}`;
      if (registered !== undefined && registered.has(skillName)) { index++; continue; }
      const desc = firstSentence(tool.description);
      const lower = desc.length > 0 ? desc[0].toLowerCase() + desc.slice(1) : desc;
      const catalogDesc = `Details for tool_call \`${tool.name}\`: ${lower}`.trim();
      const description = [catalogDesc, compactSchema(tool.parameters)].filter(Boolean).map((s, i) => i === 1 ? `Arguments: ${s}` : s).join(" ");
      const content = toolBlock(tool, schemaDump(tool.parameters), proseByTool.get(tool.name));
      if (content.length === 0) { index++; continue; }
      const skill = {
        name: skillName,
        description,
        whenToUse: `When the model intends to call the "${tool.name}" tool (this skill is "${skillName}").`,
        content,
        invocation: { modelInvocable: true, userInvocable: false },
        source: `dsh-skill-from-tools:${tool.name}`
      };
      if (agentCtx !== undefined) {
        // `agentCtx.skills` (property access) throws "cannot get property
        // skills without inject" — the agent's scoped context does not declare
        // `skills` injection. `get('skills')` reads the service from the store
        // without the inject requirement AND returns a traceable proxy bound to
        // `agentCtx`, so `register()` sees `this.ctx = agentCtx` and files the
        // skill into `scopeOf(agentCtx)` = this agent's scope layer (visible
        // only to it), not the global layer.
        agentCtx.get("skills").register(skill);
        registered.add(skillName);
      } else {
        // No agent scope (should not happen in normal operation); fall back to
        // the plugin's own context so the tool still becomes a skill.
        ctx.skills.register(skill);
      }
      index++;
    }
    // Authoritative: only `skill` stays in the LLM request's tools array.
    assembly.tools = tools.filter((tool) => tool === null || typeof tool !== "object" || typeof tool.name === "string" && EXCLUDED.has(tool.name));
    // NOTE: `tool:*` prose sections are NOT filtered here.
    return next();
  });
}

export { apply, inject, name };
