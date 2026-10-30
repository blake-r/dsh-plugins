// Lean Team entry, node half.
//
// The host half is intentionally a no-op: the whole feature lives in the
// browser half (lib/client.js) — the icon registered into the conversation
// header's utilities row and the 100%-covering modal with the kanban iframe.
// The row exists so the package mounts as a host plugin (the loader imports
// the main entry) and the `dsh.client` declaration is discovered by
// dsh-client-modules; no host service is needed.
export const name = 'dsh-client-ui-lean-team';

const inject = [];

export function apply() {}

export { inject };