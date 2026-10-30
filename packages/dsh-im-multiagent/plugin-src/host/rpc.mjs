// dsh-im-multiagent management RPC (plan section 10, Q35).
//
// Loopback-only channel "/telegram-multiagent" mounted through the vendored
// registerManagementRpc carrier (management-rpc.mjs). Endpoints:
//   mirror.list / mirror.refresh  — session roster (sessionId -> entry);
//   index.stats                   — per-chat MessageIndex entry counts;
//   settings.get / settings.update — runtime config (deliveryMode, mirroring,
//     bot card, configPath). Bot add/remove is out of v1 scope (Q35).

import { registerManagementRpc } from './management-rpc.mjs';

export const RPC_CHANNEL = '/telegram-multiagent';
export const RPC_ENDPOINTS = Object.freeze([
  'mirror.list',
  'mirror.refresh',
  'index.stats',
  'settings.get',
  'settings.update',
]);

const TELEGRAM_USER_ID = /^[1-9]\d{0,15}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSettingsPayload(payload) {
  const allowed = new Set(['deliveryMode', 'mirroring', 'allowedUsers', 'accessMode']);
  if (!Object.keys(payload).every((key) => allowed.has(key))) return false;
  if (payload.deliveryMode !== undefined
    && payload.deliveryMode !== 'steer' && payload.deliveryMode !== 'queue') return false;
  if (payload.mirroring !== undefined
    && (!isRecord(payload.mirroring) || typeof payload.mirroring.enabled !== 'boolean')) return false;
  if (payload.allowedUsers !== undefined
    && (!Array.isArray(payload.allowedUsers)
      || !payload.allowedUsers.every((id) => typeof id === 'string' && TELEGRAM_USER_ID.test(id)))) {
    return false;
  }
  if (payload.accessMode !== undefined
    && payload.accessMode !== 'compatible' && payload.accessMode !== 'private-allowlist') return false;
  return true;
}

function validPayload(endpoint, payload) {
  if (!isRecord(payload)) return false;
  if (endpoint !== 'settings.update') return Object.keys(payload).length === 0;
  return validSettingsPayload(payload);
}

export function createMultiagentRpcHandler({ mirror, index, configStore, getRuntimeConfig, applyRuntimeConfig }) {
  void configStore;
  return async (endpoint, payload, signal) => {
    if (!RPC_ENDPOINTS.includes(endpoint) || !validPayload(endpoint, payload)) {
      return { ok: false, error: { code: 'bad-request', message: 'Invalid multiagent request.' } };
    }
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'Request cancelled.' } };
    }
    try {
      let value;
      if (endpoint === 'mirror.list') {
        value = mirror.sessions();
      } else if (endpoint === 'mirror.refresh') {
        await mirror.discover();
        value = mirror.sessions();
      } else if (endpoint === 'index.stats') {
        value = index.stats();
      } else if (endpoint === 'settings.get') {
        value = getRuntimeConfig();
      } else {
        await applyRuntimeConfig(payload);
        value = getRuntimeConfig();
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: 'settings-failed', message: String(error) } };
    }
  };
}

export function installMultiagentRpc(ctx, deps, options = {}) {
  void options;
  return registerManagementRpc(ctx, RPC_CHANNEL, createMultiagentRpcHandler(deps), {
    authority: 'loopback',
  });
}