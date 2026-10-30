/**
 * dsh-host-prompt-variables
 *
 * Host plugin: registers extra prompt variables so they can be referenced as
 * `{{name}}` in any system-prompt section (identity, contexts, tool schemas).
 *
 * Out of the box the agent loop registers only `{{provider}}`, `{{model}}`,
 * and `{{cwd}}`. This plugin lets you add more via config:
 *
 *   config:
 *     variables:
 *       session_id: agent.session.header.id
 *       workspace:  agent.session.header.cwd
 *
 * Each value is a dot-path resolved against the assembly context
 * `{ agent, scope, signal }` (like Python's attrgetter): split on ".", walk
 * the keys; a missing key yields `undefined` and is logged as a warning via
 * `ctx.logger.warn` (captured by logger-console into the dsh log).
 *
 * Variable names must match /^[a-z][a-z0-9_]*$/ (lowercase only), hence
 * `session_id` not `sessionId`.
 *
 * Mechanism: `ctx.systemPrompt.variable(name, provider)` — the same API the
 * agent loop uses for the built-in variables. The provider receives the
 * assembly context and is evaluated per assembly. `systemPrompt` is a Cordis
 * service, so it must be listed in `inject` for `ctx.systemPrompt` to resolve
 * (same pattern as dsh-tool-python.mjs). The inject is declared here in the
 * module only; the config row in cordis.patch.yml does not repeat it.
 */
export const name = 'dsh-host-prompt-variables';

const inject = ['systemPrompt'];

const NAME_RE = /^[a-z][a-z0-9_]*$/;

function resolvePath(root, path) {
	if (typeof path !== 'string' || path.length === 0) return undefined;
	let current = root;
	for (const key of path.split('.')) {
		if (current == null) return undefined;
		current = current[key];
	}
	return current;
}

export function apply(ctx, config) {
	const variables = config?.variables ?? {};
	for (const [name, path] of Object.entries(variables)) {
		if (!NAME_RE.test(name)) {
			throw new Error(`invalid prompt variable name "${name}" (must match ${NAME_RE})`);
		}
		if (typeof path !== 'string' || path.length === 0) {
			throw new Error(`invalid prompt variable "${name}": value must be a non-empty dot-path string`);
		}
		ctx.systemPrompt.variable(name, (context) => {
			const value = resolvePath(context, path);
			if (value === undefined) {
				ctx.logger.warn(`prompt variable "${name}" resolved to undefined (path "${path}")`);
			}
			return value;
		});
	}
}

export { inject };