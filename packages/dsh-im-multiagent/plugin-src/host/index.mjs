// dsh-im-multiagent host plugin entry (stage 8).
//
// Wires the production pipeline (SessionMirror, InboundRouter, BotChannel,
// InteractionAdapter, MenuBuilder, stores) and mounts the loopback management
// RPC channel "/telegram-multiagent" (plan section 10, Q35). The cordis row
// stays disabled by default; the client side (plugin-src/client) is owned by
// a separate workstream.

import { createMultiagentProduction } from './production.mjs';
import { installMultiagentRpc } from './rpc.mjs';

export const name = 'dsh-im-multiagent';
export const inject = ['connection', 'credentials', 'agents', 'sessionQuery', 'workspaceRegistry'];

let applied = false;

export async function apply(ctx, config = {}) {
  if (applied) return;
  applied = true;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger(name)
    : (ctx.logger ?? console);
  if (!ctx?.credentials) {
    logger.warn?.(
      '[dsh-im-multiagent] credentials service is missing; production and management RPC are not mounted',
    );
    return;
  }
  const production = await createMultiagentProduction(ctx, config);
  installMultiagentRpc(ctx, {
    mirror: production.mirror,
    index: production.index,
    configStore: production.configStore,
    getRuntimeConfig: production.getRuntimeConfig,
    applyRuntimeConfig: production.applyRuntimeConfig,
  });
  ctx.effect(() => () => production.close(), 'dsh-im-multiagent: close');
  const botCount = production.configStore.list().length;
  logger.info?.(
    `[dsh-im-multiagent] started: chatKey=${production.chatKey}, bots=${botCount}`,
  );
}