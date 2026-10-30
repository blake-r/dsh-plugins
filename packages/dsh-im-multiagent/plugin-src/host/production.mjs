// dsh-im-multiagent production wiring (plan sections 8/10, stage 8 host).
//
// Resolves the plugin data paths, loads the Telegram config/state stores,
// builds the full host pipeline (MessageIndex, SessionMirror, BotChannel,
// CommandDispatcher, InteractionAdapter, MenuBuilder, InboundRouter) and the
// runtime config holder consumed by the management RPC. The Telegram
// transport is a no-op stub until the client side (plugin-src/client) wires
// the real TelegramBotClient; the BotChannel queue/rate-limit logic is real.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { TelegramConfigStore } from '../../src/channels/telegram/config-store.mjs';
import { TelegramStateStore } from '../../src/channels/telegram/state-store.mjs';
import { BotChannel } from './bot-channel.mjs';
import { CommandDispatcher } from './command-dispatcher.mjs';
import { createI18n } from './i18n.mjs';
import { InboundRouter } from './inbound-router.mjs';
import { InteractionAdapter } from './interaction-adapter.mjs';
import { MenuBuilder } from './menu-builder.mjs';
import { MessageIndex } from './message-index.mjs';
import { SessionMirror } from './session-mirror.mjs';

const DELIVERY_FILE = 'delivery.json';

/** Resolve the plugin data paths (mirrors the reference dsh-im layout). */
export function pluginPaths(config, channel = 'telegram-multiagent') {
  void channel;
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-telegram-multiagent'));
  return {
    config: resolve(config.configPath ?? join(root, 'config.json')),
    state: resolve(config.statePath ?? join(root, 'state.json')),
  };
}

/**
 * No-op TelegramBotClient contract (BotChannel producer): every call is a
 * no-op, sends return synthetic provider message ids so the queue plumbing
 * (split, rate gate, edit fallback) keeps working end to end.
 */
function createNoopTransport() {
  let nextId = 1;
  return {
    async sendText(target, text, options) {
      void target; void text; void options;
      return { providerMessageIds: [String(nextId++)] };
    },
    async editText(target, messageId, text) {
      void target; void messageId; void text;
    },
    async deleteMessage(target, messageId) {
      void target; void messageId;
    },
    async answerCallbackQuery(callbackQueryId, { text } = {}) {
      void callbackQueryId; void text;
    },
    async editMessageReplyMarkup(target, { replyMarkup }) {
      void target; void replyMarkup;
    },
    async setMyCommands({ commands, scope }) {
      void commands; void scope;
    },
    async deleteMyCommands() {},
  };
}

/** Numeric chat id from a "direct:<id>" / "group:<id>" chat key. */
function chatIdFromKey(chatKey) {
  const id = Number(String(chatKey).split(':')[1]);
  return Number.isSafeInteger(id) ? id : String(chatKey);
}

/** Durable deliveryMode sidecar next to state.json (atomic tmp + rename). */
async function readDeliveryMode(statePath) {
  const path = join(dirname(statePath), DELIVERY_FILE);
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.deliveryMode === 'steer' || value?.deliveryMode === 'queue') return value.deliveryMode;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return null;
}

async function writeDeliveryMode(statePath, deliveryMode) {
  const path = join(dirname(statePath), DELIVERY_FILE);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ deliveryMode }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function createMultiagentProduction(ctx, config = {}) {
  const paths = pluginPaths(config);
  const configStore = await new TelegramConfigStore(paths.config).load();
  const state = await new TelegramStateStore(paths.state).load();
  const i18n = createI18n(() => 'ru');
  const index = new MessageIndex(state);
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-im-multiagent')
    : (ctx.logger ?? console);

  // v1 = one bot: the mirror targets the first allowlisted user's private
  // chat (config.chatKey overrides).
  const bot = configStore.list()[0];
  const chatKey = config.chatKey
    ?? (bot?.allowedUsers?.length > 0 ? `direct:${bot.allowedUsers[0]}` : 'direct:0');
  const transport = createNoopTransport();
  const channel = new BotChannel({
    client: transport,
    target: { chatId: chatIdFromKey(chatKey) },
    chatKey,
    state,
    config,
    logger,
  });

  // The mirror's menu hooks are wired to the MenuBuilder through a closure
  // (the builder needs the mirror, the mirror needs the hooks).
  let menuBuilder;
  const mirror = new SessionMirror({
    state,
    index,
    i18n,
    outbound: channel,
    chatKey,
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
    config: { maxFinalTextLength: config.maxFinalTextLength },
    onSessionsChanged: () => void menuBuilder?.onSessionsChanged(),
    onActivity: () => void menuBuilder?.scheduleUpdate(),
  });
  menuBuilder = new MenuBuilder({
    state,
    mirror,
    i18n,
    config,
    client: transport,
    workspaceRegistry: ctx.workspaceRegistry,
    presets: typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined,
    logger,
  });

  // Runtime config holder: deliveryMode is live (the router reads it per
  // delivery) and durable (sidecar); mirroring lives in the state store.
  const persistedDeliveryMode = await readDeliveryMode(paths.state);
  const runtime = {
    deliveryMode: persistedDeliveryMode ?? config.deliveryMode ?? 'steer',
    mirroring: state.mirroring(),
  };

  const commands = new CommandDispatcher({ ctx, config, state, index, mirror, i18n, logger });
  const interactions = new InteractionAdapter({
    ctx, config, state, index, mirror, outbound: channel, chatKey, i18n, logger,
  });
  interactions.start();
  const router = new InboundRouter({
    ctx, config: runtime, state, index, mirror, i18n, commands, interactions, logger,
  });
  router.withBot(channel);

  function getRuntimeConfig() {
    const current = configStore.list()[0];
    return {
      deliveryMode: runtime.deliveryMode,
      mirroring: state.mirroring(),
      bot: current
        ? {
            botId: current.botId,
            platformId: current.platformId,
            name: current.name,
            username: current.username,
            accessMode: current.accessMode,
            allowedUsers: current.allowedUsers,
          }
        : null,
      configPath: paths.config,
    };
  }

  async function applyRuntimeConfig(patch) {
    if (patch.deliveryMode !== undefined) {
      runtime.deliveryMode = patch.deliveryMode;
      await writeDeliveryMode(paths.state, patch.deliveryMode);
    }
    if (patch.mirroring !== undefined) {
      await state.setMirroring(patch.mirroring.enabled);
    }
    if (patch.accessMode !== undefined || patch.allowedUsers !== undefined) {
      const current = configStore.list()[0];
      if (!current) throw new Error('No bot configured');
      await configStore.save({
        ...current,
        ...(patch.accessMode !== undefined ? { accessMode: patch.accessMode } : {}),
        ...(patch.allowedUsers !== undefined ? { allowedUsers: patch.allowedUsers } : {}),
      });
    }
    return getRuntimeConfig();
  }

  return {
    mirror,
    index,
    router,
    state,
    configStore,
    getRuntimeConfig,
    applyRuntimeConfig,
    chatKey,
    async start() {
      await mirror.start();
    },
    async close() {
      await mirror.stop();
    },
  };
}