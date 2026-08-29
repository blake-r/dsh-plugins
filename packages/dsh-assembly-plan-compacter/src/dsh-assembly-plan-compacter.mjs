// dsh-assembly-plan-compacter — make plan_mode print the full plan in the reply and
// exit_plan_mode carry only a brief (short summary of conclusions + planned
// changes). Overrides the hardcoded exit_plan_mode tool description in the
// assembled system prompt via the system-prompt/assemble waterfall.
//
// Lives in the WEB profile so it applies to all web sessions regardless of
// preset. It is registered BEFORE `tools-as-skills` in the insert list so its
// description override is applied first and captured into the `exit_plan_mode`
// skill body (the `plan` module).
//
// The "Chat about it" reframe: when the user dismisses the plan review to chat
// instead of choosing Approve/Keep planning, `dsh-plan-mode`'s
// `interaction.ask` throws `UserQuestionError` with code `ASK_CANCELLED`,
// which the catch (lib/index.js:309-312) converts into the tool result "The
// user dismissed the plan review to speak instead; stay in plan mode, stop
// here, and wait for their message." The model's ONLY frame for that outcome
// is the tool description, so the description must explicitly state that
// dismissal is NOT a rejection — the user wants to discuss/add to the plan;
// stop, wait, incorporate, and re-present. Without that clause the model
// treats dismissal as a plan rejection and gets defensive. The error text
// itself lives in node_modules (fragile to edit); the description override is
// the correct lever.
const name = "dsh-assembly-plan-compacter";
const inject = ["systemPrompt"];

function apply(ctx) {
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    const tool = assembly.tools?.find((t) => t.name === "exit_plan_mode");
    if (tool) {
      tool.description =
        "Use only in plan mode. The COMPLETE plan must already be written out in plain text in your reply for the user to review. " +
        "Pass here ONLY a brief: a very short summary of your conclusions and the planned changes (a few bullet points). " +
        "The brief must start with a # heading that names the plan. " +
        "The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again. " +
        "If the user dismisses the review to chat instead of choosing an option, that is NOT a rejection of your plan — they simply want to discuss or add to it. Stop, wait for their message, incorporate their additions, and present the revised plan again when they are ready.";
      if (tool.parameters?.plan) {
        tool.parameters.plan.description =
          "A brief (very short summary of conclusions and planned changes), as markdown starting with a # heading. The full plan is already in your reply.";
      }
    }
    return next();
  });
}

export { apply, inject, name };
