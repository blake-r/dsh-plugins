/**
 * dsh-client-ui-wider-chat
 *
 * Host plugin: widens the conversation output column to (almost) full width
 * while keeping the composer (input) card at its current width.
 *
 * Mechanism: the conversation body element (`.wSkVaW_body` in the current
 * client) declares two CSS variables —
 *   --dsh-chat-content-width: 748px            (message column max-width)
 *   --dsh-composer-card-max-width: calc(748px + 32px)  (composer card max-width)
 * We override them on `[data-conversation-content]` with `!important` so the
 * two stay decoupled:
 *   - dialog: max(748px, calc(100% - 64px))  -> full width minus a 64px margin,
 *     never narrower than the current 748px minimum.
 *   - composer: fixed at 780px (current value), unchanged.
 *
 * Targeting `[data-conversation-content]` (not the hashed CSS-module class,
 * e.g. `.wSkVaW_body`) is deliberate: the attribute is stable across
 * rebuilds/upgrades, and `!important` beats the body's own plain declaration
 * regardless of specificity or injection order. This keeps the override
 * working even when the hashed class name changes.
 *
 * Note: since dsh 0.1.7-rc.2 the variables moved from the root
 * `[data-phase]` element (`.wSkVaW_root`) down to the body element; the
 * `[data-phase]` root selector is kept as a fallback for older clients.
 *
 * The style is injected into the served index.html head via the
 * `webserver/index-inject` event (kind: 'style').
 */
export const name = 'dsh-client-ui-wider-chat';

export function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'style',
      text: '[data-conversation-content],[data-phase]{--dsh-chat-content-width:max(748px,calc(100% - 64px))!important;--dsh-composer-card-max-width:780px!important}',
    });
  });
}