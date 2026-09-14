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
//       hint: <placeholder shown in the composer after picking the command;
//              optional, defaults to "optional text">
//
// Every command accepts an optional trailing text: the registration declares
// `input: { hint }`, so picking the command from the GUI slash menu inserts
// `/name ` into the composer (hint shown as placeholder) instead of executing
// it immediately, and the user can type accompanying text before pressing
// Enter. When the submitted line carries trailing text, it is appended to the
// prompt (separated by a blank line) in the model-visible message.
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
//   - `input: { hint }` drives the client pick path: `dsh-client-ui-commands`
//     routes a menu pick of a command with `input` to a composer claim
//     (`/name ` + hint placeholder) and only runs it on Enter, while a command
//     without `input` executes detached (immediately) on pick. The trailing
//     text arrives at the handler as `invocation.rawInput` ("" when absent).
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

    const hint =
      typeof def.hint === "string" && def.hint.trim().length > 0
        ? def.hint.trim()
        : "optional text";

    const dispose = ctx.commands.register({
      name: cmdName,
      description,
      // Declared input keeps the slash-menu pick in the composer (`/name ` with
      // this hint as placeholder) instead of executing the command right away.
      input: { hint },
      handler: (invocation) => {
        const text =
          typeof invocation.rawInput === "string"
            ? invocation.rawInput.trim()
            : "";
        const message = text.length > 0 ? `${prompt}\n\n${text}` : prompt;
        invocation.agent.followup(buildUserMessage(message));
        return {
          kind: "success",
          text:
            text.length > 0
              ? `Sent the "${cmdName}" prompt with your text to the model.`
              : `Sent the "${cmdName}" prompt to the model.`
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