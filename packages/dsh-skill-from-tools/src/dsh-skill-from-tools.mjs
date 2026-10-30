// dsh-skill-from-tools — every non-`skill` tool stays directly invocable in the
// LLM request's `tools` array, and ALSO becomes a skill that holds the tool's
// full details as an on-demand detail layer.
//
// TOOLS ZONE (assembly.tools): each tool keeps a SHORT form — the first
// sentence of its description — and a MINIMAL JSON Schema. The schema stays a
// real object (the LLM tool-call layer consumes `parameters` as JSON Schema, so
// a compact string would break argument generation). Every annotation is
// stripped recursively — `description`, `title`, `examples`, `default`,
// `$comment`, `enumDescriptions` — while all structure is kept: `type`,
// `required`, `enum`/`const` VALUES, `items`, `properties`, `$ref`,
// `oneOf`/`anyOf`. The enum/const values are never dropped, only the prose
// around them.
//
// SKILLS: one skill per tool (except `skill` itself). The catalog `description`
// is a bare comment — `Tool details for \`X\`.` — with no schema, so the catalog
// stays tiny. The skill `content` carries the FULL description, the
// `tool:<name>` prose guidance from the assembly, and the VERBATIM (fully
// annotated) JSON Schema under an explicit `Arguments (JSON Schema):` label.
// `whenToUse` signals the skill is a DETAIL reference, not an invocation path.
//
// CRITICAL: skill ids MUST be valid per the grammar `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
// Registering with `name: tool.name` (e.g. `todo_write`, `exit_plan_mode`,
// `ask_user_question`) — which contain underscores — throws `invalid skill
// name`, and the exception thrown inside the `system-prompt/assemble` waterfall
// listener aborts the WHOLE waterfall → NO skills registered at all (empty
// catalog, "skills disappeared"). Fix: every skill id is a SLUG of the tool name
// (`todo_write` → `todo-write`, `mcp__browser__click` → `mcp-browser-click`).
//
// STABILITY: the id is derived from the TOOL NAME ONLY — never from its index in
// the assembly's tools array. The array order changes between assembles (MCP
// tools appear later than built-ins), so an index-based id (`t<hex><initials>`)
// produced a DIFFERENT id for the same tool on a later assemble; the per-agent
// "already registered" guard then missed and the whole catalog was registered a
// second time under new ids — visible as duplicate entries (`t30nn`/`t31nn` for
// one tool). A name-derived id is stable across assembles and orders.
//
// COLLISIONS: two different tool names can slug to the same id (`mcp__a__b` vs
// `mcp-a-b`). A pre-pass over all tools detects that and appends a short hash of
// the full tool name to EVERY colliding id, so the result does not depend on
// which one comes first.
//
// SCOPE: this plugin ONLY moves tool details out of the LLM context into
// skills. It does NOT strip the `tool:<name>` prose sections out of the system
// prompt — that is `dsh-assembly-tools-prompt-strip`'s job (kept as-is).
// Keeping the two concerns separate means each plugin has a single
// responsibility.
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
// The `skill` loader stays in the prompt; every other tool is both directly
// invocable and skill-backed.
const EXCLUDED = new Set(["skill"]);

// Skill-id slug: lowercase alphanumerics joined by single hyphens, which is
// exactly the skill-name grammar.
function slugify(text) {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "tool";
}

// Stable 6-hex-digit FNV-1a digest of a tool name; used only to disambiguate
// slugs that collide.
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

// Map tool name → skill id for one assembly. Ids depend on the tool NAMES only,
// so they stay identical across assembles regardless of array order.
function skillIds(tools) {
  const slugs = new Map();
  const counts = new Map();
  for (const tool of tools) {
    const slug = slugify(tool.name);
    slugs.set(tool.name, slug);
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const ids = new Map();
  for (const tool of tools) {
    const slug = slugs.get(tool.name);
    ids.set(tool.name, counts.get(slug) > 1 ? `${slug}-${shortHash(tool.name)}` : slug);
  }
  return ids;
}

// First sentence of a description; '' when empty.
function firstSentence(text) {
  if (typeof text !== "string") return "";
  const t = text.replaceAll(/\s+/g, " ").trim();
  if (t.length === 0) return "";
  const m = t.match(/^.*?[.!?](?:\s|$)/);
  return m ? m[0].trim() : t;
}

// Recursively strip every annotation from a JSON Schema node, keeping only
// structure. Annotations dropped: `description`, `title`, `examples`, `default`,
// `$comment`, `enumDescriptions`. Everything else — `type`, `required`,
// `enum`/`const` VALUES, `items`, `properties`, `$ref`, `oneOf`/`anyOf` — is
// kept and recursed into. The result is still a valid schema object the LLM
// tool-call layer can consume.
function stripSchema(node) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(stripSchema);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "description" ||
      key === "title" ||
      key === "examples" ||
      key === "default" ||
      key === "$comment" ||
      key === "enumDescriptions"
    ) {
      continue;
    }
    out[key] = typeof value === "object" && value !== null ? stripSchema(value) : value;
  }
  return out;
}

// Minified JSON Schema for a tool's parameters, verbatim from the registry;
// '' when there are none.
function schemaDump(parameters) {
  if (parameters === undefined || parameters === null || typeof parameters !== "object") return "";
  return JSON.stringify(parameters);
}

// Full content block for one tool: `## \`<tool>\` tool` + a detail-reference
// note + the FULL description + the `tool:<name>` prose guidance section from
// the assembly (when present) + the tool's VERBATIM JSON SCHEMA under an
// explicit `Arguments (JSON Schema):` label. The catalog `description` keeps
// only the bare "Tool details for `X`." comment; the content block carries the
// complete description, the full prose guidance, and the schema.
//
// ARGUMENTS LABEL: without it the schema line would follow prose that may
// itself mention fields, leaving no marker for where the parameter schema
// begins, and a bare JSON line would read as one more prose sentence. The label
// also names the dialect, and it is omitted only when the tool takes no
// parameters.
//
// DISAMBIGUATION: the bare word "tool" is ambiguous — a model that reads the
// skill may not know how to invoke it. The explicit note below pins the
// mechanism: the tool is invoked as a direct `tool_call` with its own name.
function toolBlock(toolName, fullDesc, schemaText, proseText) {
  return [
    `## \`${toolName}\` tool`,
    `Full details for the \`${toolName}\` tool; invoke it directly as a tool_call.`,
    fullDesc,
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
    const ids = skillIds(all);
    for (const tool of all) {
      const skillName = ids.get(tool.name);
      const alreadyRegistered = registered !== undefined && registered.has(skillName);
      // Capture the FULL description and VERBATIM schema BEFORE the tools zone
      // is shortened, so the skill content keeps the complete detail layer.
      const fullDesc = typeof tool.description === "string" ? tool.description.replaceAll(/\s+/g, " ").trim() : "";
      const verbatimSchema = schemaDump(tool.parameters);
      // Tools zone: short description + minimal schema (annotations stripped).
      //
      // MUST run on EVERY assemble, not only on the first one. The assembly is
      // rebuilt from the tool providers before each waterfall run and every
      // schema is `structuredClone`d there, so the shortening applied to a
      // previous assembly never survives into the next step. Guarding this
      // block with `alreadyRegistered` left every step after the first with
      // FULL descriptions and fully annotated schemas — the plugin looked dead.
      // Only the SKILL registration is idempotent; the tools-zone shortening is
      // per-assembly and unconditional.
      tool.description = firstSentence(tool.description);
      if (tool.parameters !== undefined && tool.parameters !== null && typeof tool.parameters === "object") {
        tool.parameters = stripSchema(tool.parameters);
      }
      if (alreadyRegistered) continue;
      // Catalog: a bare comment naming the tool, no schema — the schema lives
      // in the tools zone and the full detail layer lives in the content.
      const description = `Tool details for \`${tool.name}\`.`;
      const content = toolBlock(tool.name, fullDesc, verbatimSchema, proseByTool.get(tool.name));
      if (content.length === 0) continue;
      const skill = {
        name: skillName,
        description,
        whenToUse: `When the model needs full details or guidance for the "${tool.name}" tool (this skill is "${skillName}").`,
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
    }
    // Authoritative: every tool stays in the LLM request's tools array — the
    // skills are a detail layer, not a replacement. No filtering here.
    return next();
  });
}

export { apply, inject, name };
