// dsh-im-multiagent client (stage 8, plan section 10).
//
// Settings page for the Telegram multiagent plugin: bot card (token, chat
// allowlist, delivery mode) + mirror sessions table + per-chat index stats.
// Renders into the `settings.section` slot and talks to the host through the
// vendored management RPC carrier (plugin-src/host/management-rpc.mjs),
// channel "/telegram-multiagent".
//
// Plain JS, no framework: DOM is built with the same `h` helper convention
// dsh-im uses (a React.createElement wrapper), state with the React hooks the
// client platform seeds. lib/client.js is GENERATED from this file by
// `npm run build:client` (scripts/build.mjs): the body is wrapped in the
// client-modules bundle format (window.__ModuleLoader__.load), `React.*` is
// rewritten to `react.*`, and the local import of callManagementRpc is
// inlined from the vendored host file. Do not edit lib/client.js by hand.

import { callManagementRpc } from '../host/management-rpc.mjs';

export const name = 'dsh-im-multiagent-client';
export const inject = ['slots', 'connection', 'locale'];

const RPC_CHANNEL = '/telegram-multiagent';

// CSS for the settings page, injected once at materialization (same
// data-plugin-css guard the official client bundles use).
const css = [
  '.mta-page{display:flex;flex-direction:column;gap:16px;max-width:760px}',
  '.mta-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:10px;padding:16px 20px}',
  '.mta-cardHeader{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.mta-cardTitle{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.mta-identity{display:flex;align-items:center;gap:12px;margin:0 0 14px}',
  '.mta-identityName{display:flex;flex-direction:column;gap:2px}',
  '.mta-identityName strong{font-size:14px;color:var(--dsw-alias-label-primary)}',
  '.mta-identityName span{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mta-token{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-mask-1);border-radius:4px;padding:2px 8px}',
  '.mta-field{display:flex;flex-direction:column;gap:6px;margin:0 0 12px}',
  '.mta-field > span{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mta-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.mta-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}',
  '.mta-button{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:6px 14px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}',
  '.mta-button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.mta-button:disabled{opacity:.55;cursor:default}',
  '.mta-tableWrap{overflow-x:auto}',
  '.mta-table{width:100%;border-collapse:collapse;font-size:12px}',
  '.mta-table th{text-align:left;padding:6px 10px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-interactive-bg-hover)}',
  '.mta-table td{padding:6px 10px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-interactive-bg-hover)}',
  '.mta-table tr:last-child td{border-bottom:none}',
  '.mta-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mta-stats{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mta-notice{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-mask-1);border-radius:6px;padding:6px 10px}',
  '.mta-error{font-size:13px;color:var(--dsw-alias-state-error-primary)}',
].join('');

/** DOM helper in the dsh-im convention: thin React.createElement wrapper. */
function h(type, props, ...children) {
  return React.createElement(type, props, ...children);
}

/** Wrap the vendored carrier for the fixed multiagent channel. */
function rpcCall(connection, endpoint, payload, signal) {
  return callManagementRpc(connection, RPC_CHANNEL, endpoint, payload, signal);
}

/** Unwrap the { ok, value | error } management RPC envelope. */
async function unwrap(result) {
  if (result?.ok === false) {
    const error = result.error ?? {};
    throw new Error(error.message ?? 'Telegram Multiagent request failed');
  }
  return result?.value;
}

/** maskTelegramBotId-style token mask: keep only the last 4 chars. */
function maskBotToken(botId) {
  const value = String(botId ?? '');
  if (value.length <= 4) return value ? '••••' : '—';
  return `••••${value.slice(-4)}`;
}

function formatActivity(ts) {
  if (!Number.isFinite(ts)) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch {
    return String(ts);
  }
}

const STATUS_LABELS = Object.freeze({
  cold: 'cold',
  working: 'working',
  idle: 'idle',
  'awaiting-approval': 'awaiting approval',
  interrupted: 'interrupted',
  error: 'error',
  closed: 'closed',
  restarted: 'restarted',
  'no-text': 'no text',
});

function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? '—');
}

function modelLabel(model) {
  if (!model) return '—';
  return model.model || model.provider || '—';
}

function BotCard({ settings, form, setForm, busy, onSave }) {
  const bot = settings?.bot;
  const disabled = busy || !bot;
  return h('section', { className: 'mta-card', 'aria-label': 'Bot' },
    h('h3', { className: 'mta-cardTitle' }, 'Bot'),
    bot
      ? h('div', { className: 'mta-identity' },
          h('div', { className: 'mta-identityName' },
            h('strong', null, bot.name ?? '—'),
            h('span', null, bot.username ? `@${bot.username}` : `id ${bot.botId ?? '—'}`)),
          h('code', { className: 'mta-token' }, maskBotToken(bot.botId)))
      : h('p', { className: 'mta-muted' }, 'No bot configured.'),
    h('label', { className: 'mta-field' },
      h('span', null, 'Access mode'),
      h('select', {
        className: 'mta-input',
        value: form?.accessMode ?? 'compatible',
        disabled,
        onChange: (event) => setForm({ ...form, accessMode: event.target.value }),
      },
      h('option', { value: 'compatible' }, 'compatible'),
      h('option', { value: 'private-allowlist' }, 'private-allowlist'))),
    h('label', { className: 'mta-field' },
      h('span', null, 'Allowed users (one Telegram user id per line)'),
      h('textarea', {
        className: 'mta-input mta-textarea',
        rows: 4,
        spellCheck: false,
        disabled,
        value: form?.allowedUsers ?? '',
        onChange: (event) => setForm({ ...form, allowedUsers: event.target.value }),
      })),
    h('label', { className: 'mta-field' },
      h('span', null, 'Delivery mode'),
      h('select', {
        className: 'mta-input',
        value: form?.deliveryMode ?? 'steer',
        disabled,
        onChange: (event) => setForm({ ...form, deliveryMode: event.target.value }),
      },
      h('option', { value: 'steer' }, 'steer'),
      h('option', { value: 'queue' }, 'queue'))),
    h('button', {
      type: 'button',
      className: 'mta-button',
      disabled,
      onClick: onSave,
    }, busy ? 'Saving…' : 'Save'));
}

function MirrorSection({ sessions, stats, busy, onRefresh }) {
  const rows = Object.entries(sessions ?? {})
    .map(([sessionId, entry]) => ({ sessionId, entry }))
    .sort((left, right) => (right.entry?.lastActivityTs ?? 0) - (left.entry?.lastActivityTs ?? 0));
  const statsLine = Object.entries(stats ?? {})
    .map(([chatKey, count]) => `${chatKey}: ${count}`)
    .join(' · ');
  return h('section', { className: 'mta-card', 'aria-label': 'Mirror sessions' },
    h('div', { className: 'mta-cardHeader' },
      h('h3', { className: 'mta-cardTitle' }, 'Mirror sessions'),
      h('button', {
        type: 'button',
        className: 'mta-button',
        disabled: busy,
        onClick: onRefresh,
      }, busy ? 'Refreshing…' : 'Refresh list')),
    rows.length === 0
      ? h('p', { className: 'mta-muted' }, 'No sessions mirrored yet.')
      : h('div', { className: 'mta-tableWrap' },
          h('table', { className: 'mta-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, 'Name'),
                h('th', null, 'Status'),
                h('th', null, 'Workspace'),
                h('th', null, 'Preset'),
                h('th', null, 'Model'),
                h('th', null, 'Last activity'))),
            h('tbody', null, rows.map(({ sessionId, entry }) =>
              h('tr', { key: sessionId },
                h('td', null, entry?.name ?? sessionId),
                h('td', null, statusLabel(entry?.status)),
                h('td', null, entry?.workspace ?? '—'),
                h('td', null, entry?.preset ?? '—'),
                h('td', null, modelLabel(entry?.model)),
                h('td', null, formatActivity(entry?.lastActivityTs))))))),
    statsLine
      ? h('p', { className: 'mta-stats' }, h('strong', null, 'Index'), ` ${statsLine}`)
      : null);
}

function MultiagentSettingsTab({ rpcCall, connection }) {
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [settings, setSettings] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [sessions, setSessions] = React.useState({});
  const [stats, setStats] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const mounted = React.useRef(true);

  const invoke = React.useCallback(async (endpoint, payload = {}, signal) => {
    return unwrap(await rpcCall(connection, endpoint, payload, signal));
  }, [rpcCall, connection]);

  const loadAll = React.useCallback(async ({ signal, silent = false } = {}) => {
    if (!silent) setPhase('loading');
    try {
      const [nextSettings, nextSessions, nextStats] = await Promise.all([
        invoke('settings.get', {}, signal),
        invoke('mirror.list', {}, signal),
        invoke('index.stats', {}, signal),
      ]);
      if (!mounted.current || signal?.aborted) return;
      setSettings(nextSettings);
      setForm({
        accessMode: nextSettings?.bot?.accessMode ?? 'compatible',
        allowedUsers: (nextSettings?.bot?.allowedUsers ?? []).join('\n'),
        deliveryMode: nextSettings?.deliveryMode ?? 'steer',
      });
      setSessions(nextSessions ?? {});
      setStats(nextStats ?? {});
      setError(null);
      setPhase('ready');
    } catch (caught) {
      if (caught?.name !== 'AbortError' && mounted.current && !signal?.aborted) {
        setError(caught);
        setPhase('error');
      }
    }
  }, [invoke]);

  React.useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadAll({ signal: controller.signal });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [loadAll]);

  const save = React.useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const allowedUsers = (form?.allowedUsers ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const next = await invoke('settings.update', {
        accessMode: form?.accessMode ?? 'compatible',
        allowedUsers,
        deliveryMode: form?.deliveryMode ?? 'steer',
      });
      if (!mounted.current) return;
      setSettings(next);
      setForm({
        accessMode: next?.bot?.accessMode ?? form?.accessMode ?? 'compatible',
        allowedUsers: (next?.bot?.allowedUsers ?? allowedUsers).join('\n'),
        deliveryMode: next?.deliveryMode ?? form?.deliveryMode ?? 'steer',
      });
      setNotice('Settings saved');
    } catch (caught) {
      if (mounted.current) setNotice(`Save failed: ${caught.message}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [invoke, form]);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      await invoke('mirror.refresh', {});
      const next = await invoke('mirror.list', {});
      if (!mounted.current) return;
      setSessions(next ?? {});
      setNotice('Session list refreshed');
    } catch (caught) {
      if (mounted.current) setNotice(`Refresh failed: ${caught.message}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [invoke]);

  return h('section', { className: 'mta-page', 'aria-label': 'Telegram Multiagent' },
    h('h2', { className: 'mta-cardTitle' }, 'Telegram Multiagent'),
    phase === 'loading'
      ? h('div', { className: 'mta-muted', 'aria-busy': 'true' }, 'Loading…')
      : phase === 'error'
        ? h('div', { className: 'mta-error', role: 'alert' },
            h('p', null, `Failed to load: ${error?.message}`),
            h('button', {
              type: 'button',
              className: 'mta-button',
              onClick: () => void loadAll(),
            }, 'Retry'))
        : h(React.Fragment, null,
            h(BotCard, { settings, form, setForm, busy, onSave: save }),
            h(MirrorSection, { sessions, stats, busy, onRefresh: refresh }),
            notice ? h('div', { className: 'mta-notice', role: 'status' }, notice) : null));
}

export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'blake-r-dsh-im-multiagent',
    order: 22,
    label: () => 'Telegram Multiagent',
    inject: () => ({ rpcCall, connection: ctx.connection }),
  }, MultiagentSettingsTab));
}