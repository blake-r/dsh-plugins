// dsh-command-from-prompt — a generic "command = user prompt" plugin for the web
// profile.
//
// It reads a map of command definitions from this row's `config` and
// registers each as a slash command. Invoking a command sends the model a user
// message with that command's prompt text, so the model acts on it (e.g. create
// a commit, review the diff, summarize the session, ...). Both the set of
// commands and their prompts are fully configurable — no code changes needed to
// add or tweak a command.
//
// Config shape (see the profile's cordis.patch.yml):
//   config:
//     <name>:
//       description: <short help shown in the command list>
//       prompt: <user-message text sent to the model>
//
// Implementation notes:
//   - Profile-local plugin files are loaded dependency-free, so this plugin
//     does NOT import @deepseek-ai/dsh-llm. The user message is built inline
//     with the same shape `createUserMessage` produces: `{ id, role:"user",
//     content:[{type:"text",text}], source:{kind:"user"} }` (see
//     dsh-llm/lib/index.js createUserMessage / createMessage). It is delivered
//     through `invocation.agent.followup(message)` — the seam used to inject a
//     model-visible user message.
//   - The `commands` service is host-plane (mounted by dsh-base, not disabled
//     in the web profile), so these commands are available in every web session.
//   - Commands take no arguments (`input` omitted), so handlers ignore
//     `invocation.rawInput`.
//
// After editing this file bump the `?v=` in the referencing row of the
// profile's cordis.patch.yml, otherwise the loader may serve the cached module.

const name = "dsh-command-from-prompt";
const inject = ["commands"];

/** Build a model-visible user message inline (no dsh-llm import). */
function buildUserMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" }
  };
}

function apply(ctx, config) {
  const commands = config ?? {};
  const disposers = [];

  for (const [cmdName, def] of Object.entries(commands)) {
    if (!def || typeof def !== "object") continue;

    const prompt =
      typeof def.prompt === "string" && def.prompt.trim().length > 0
        ? def.prompt.trim()
        : null;
    if (!prompt) continue;

    const description =
      typeof def.description === "string" && def.description.trim().length > 0
        ? def.description.trim()
        : `send the configured prompt to the model`;

    const dispose = ctx.commands.register({
      name: cmdName,
      description,
      handler: (invocation) => {
        invocation.agent.followup(buildUserMessage(prompt));
        return {
          kind: "success",
          text: `Sent the "${cmdName}" prompt to the model.`
        };
      }
    });
    if (typeof dispose === "function") disposers.push(dispose);
  }

  // Return a disposer so HMR re-apply unregisters the commands before
  // re-registering them (otherwise re-apply fails with "already registered").
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { apply, inject, name };
