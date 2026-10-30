// dsh-command-status-interrupt — a /status command that aborts the running
// generation and asks the model for a progress report WITHOUT opening a new
// turn and WITHOUT a user bubble.
//
// Mechanism:
//   1. While the agent is running, the command injects a system-role message
//      (`source.kind === "system"`) into the agent's next-step inbox and then
//      cancels the current generation (`keepInbox: true`). `inject` does not
//      wake the driver, so the message is queued before the abort is seen.
//   2. The agent-loop patch (patches/dsh-agent-loop.patch) makes `turn()`
//      resume the SAME turn after an abort when next-step messages are
//      pending: it resets the AbortController and continues the loop, so the
//      status report is produced in the turn that was interrupted. The turn
//      counter does not change (unlike `followup`, which opens a new turn).
//   3. The same patch routes `source.kind === "system"` messages to
//      `system/message` events instead of `user/message`, so the status prompt
//      is not a user bubble and does not look like a real user request.
//
// When the agent is idle the command falls back to `steer` (a normal new turn
// with the prompt as a system node).
//
// Config shape (see the profile's cordis.patch.yml):
//   config:
//     prompt: <the status prompt text sent to the model>
//             (defaults to the report shape below)
//     hint: <composer placeholder shown after picking the command, optional>

const name = "dsh-command-status-interrupt";
const inject = ["commands"];

const DEFAULT_PROMPT = `Based only on the current context, output a report, structured as follows:
1. Goal — the objective the agent is working toward.
2. Plan — the list of planned steps, each marked as done (✓) or not done (✗).
3. Artifacts — files, outputs, or results produced so far.
4. Logical findings — key conclusions and insights relevant to executing the plan.
5. Nearest next action — the single immediate step to take next, in accordance with the plan.
Base the report on the actual state of the session, not on assumptions.
Use \`ask-user-question\` tool_call to ask user about decisions.`;

/** Build a system-role message inline (no dsh-llm import); the agent-loop
 *  patch routes `role === "system"` messages to system/message. The session
 *  model requires `system-prompt` source kind for system/message rows
 *  (assertMessageEventShape), so the producer-owned `plugin:<name>` kind
 *  must not be used here. */
function buildSystemMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: "system",
    content: [{ type: "text", text }],
    source: { kind: "system-prompt" }
  };
}

function apply(ctx, config) {
  const prompt =
    typeof config?.prompt === "string" && config.prompt.trim().length > 0
      ? config.prompt.trim()
      : DEFAULT_PROMPT;
  const hint =
    typeof config?.hint === "string" && config.hint.trim().length > 0
      ? config.hint.trim()
      : "follow-up instructions";

  const dispose = ctx.commands.register({
    name: "status",
    description:
      "Abort the current generation and output an agent report — goal, plan with completion marks, artifacts, findings, next action",
    // Declared input keeps the slash-menu pick in the composer (`/status `
    // with this hint as placeholder) instead of executing the command right
    // away.
    input: { hint },
    handler: (invocation) => {
      const text =
        typeof invocation.rawInput === "string" ? invocation.rawInput.trim() : "";
      const message = buildSystemMessage(
        text.length > 0 ? `${prompt}\n\n${text}` : prompt
      );
      const agent = invocation.agent;
      if (agent.status === "running") {
        // Queue the prompt first (inject does not wake the driver), then abort
        // the current generation. The patched turn() resumes the same turn and
        // claims the queued next-step message.
        agent.inject(message);
        agent.cancel({ kind: "user" }, { keepInbox: true });
      } else {
        agent.steer(message);
      }
      return {
        kind: "success",
        text:
          text.length > 0
            ? `Aborted the current generation and queued the status request with your text.`
            : `Aborted the current generation and queued the status request.`
      };
    }
  });

  // Return a disposer so HMR re-apply unregisters the command before
  // re-registering it (otherwise re-apply fails with "already registered").
  return () => {
    if (typeof dispose === "function") dispose();
  };
}

export { apply, inject, name };