// dsh-im-multiagent message catalog (plan section 6.9).
//
// Single source of truth for every bot-facing text. Code refers to catalog
// keys, never to literal strings. The active language is global
// (`language: 'ru' | 'en'` in config.json, default 'en') and hot-reloads
// with the rest of the config.
//
// Placeholders ({name}, {tool}, {n}, {m}, {status}, {time}, {text}) are
// substituted by code. Russian plural forms (1 / 2-4 / 5+) are provided for
// countable keys; English uses a single form.

const RU = Object.freeze({
  'status.cold': 'холодная',
  'status.thinking': '⏳ думает',
  'status.waiting': '⏹ ожидает',
  'status.awaiting-approval': '⏸ ожидает ответа',
  'status.interrupted': '⏹ прервано',
  'status.error': '⏹ прервано/ошибка',
  'status.no-text': '⏹ (без текста)',
  'status.closed': '⏹ сессия закрыта',
  'status.restarted': '⏹ прервано рестартом',
  'status.mirror-off': '⏹ зеркало выключено',
  'status.placeholder': '⏳ {name}: думает…',
  'status.tool': '🔧 {tool}',
  'status.queued': '⏳ {name}: в очереди ({n})',
  'hint.no-recipient': 'Отвечайте на сообщение сессии (reply) или укажите адресата через /to, либо выведите историю сессии — /hs — и ответьте на неё',
  'hint.reply-or-to': 'reply на сообщение сессии или /to',
  'hint.text-only': 'только текстовые сообщения',
  'hint.follow-off': 'follow-режим выключен, включите /follow',
  'hint.follow-not-on': 'follow не включён',
  'hint.cmd-reply': 'reply на сообщение сессии, затем /cmd или /skill',
  'hint.interaction-done': 'интеракция уже обработана',
  'hint.session-gone': 'сессия недоступна',
  'hint.no-messages': 'сообщений нет',
  'hint.more-messages': '…ещё {m} сообщений',
  'hint.no-commands': 'у {name} нет команд',
  'hint.no-skills': 'у {name} нет скиллов',
  'hint.command-not-found': 'команда не найдена у {name}',
  'hint.skill-unavailable': 'скилл недоступен',
  'hint.no-active-turn': 'нет активного хода',
  'hint.picker-expired': 'пикер истёк, повторите /to',
  'hint.queue-full': 'очередь переполнена (максимум 10)',
  'hint.cold-compact': 'сессия не запущена — /compact требует живой сессии',
  'hint.foreign-bot': 'reply на сообщение чужого бота',
  'snapshot.overview': 'Сессий: {n} ({m} холодных)',
  'snapshot.per-session': '{name} [{status}]: {text}',
  'snapshot.more': '…и ещё {n} — /as',
  'picker.to-title': 'Куда отправить следующее сообщение?',
  'picker.cmd-title': 'Команды {name} ({n}):',
  'start.greeting': 'Привет! Я зеркало ваших dsh-агентов. /follow — снапшот и живое отслеживание, /as — список сессий, /help — справка.',
  'start.hint': 'напишите /follow для снапшота',
  'history.format': '🤖 {name} · {time}: {text}',
});

const EN = Object.freeze({
  'status.cold': 'cold',
  'status.thinking': '⏳ thinking',
  'status.waiting': '⏹ waiting',
  'status.awaiting-approval': '⏸ awaiting reply',
  'status.interrupted': '⏹ interrupted',
  'status.error': '⏹ interrupted/error',
  'status.no-text': '⏹ (no text)',
  'status.closed': '⏹ session closed',
  'status.restarted': '⏹ interrupted by restart',
  'status.mirror-off': '⏹ mirror off',
  'status.placeholder': '⏳ {name}: thinking…',
  'status.tool': '🔧 {tool}',
  'status.queued': '⏳ {name}: queued ({n})',
  'hint.no-recipient': 'Reply to a session message, or pick a recipient with /to, or view session history with /hs and reply to it',
  'hint.reply-or-to': 'reply to a session message or use /to',
  'hint.text-only': 'text messages only',
  'hint.follow-off': 'follow mode is off — enable it with /follow',
  'hint.follow-not-on': 'follow is not enabled',
  'hint.cmd-reply': 'reply to a session message, then use /cmd or /skill',
  'hint.interaction-done': 'interaction already handled',
  'hint.session-gone': 'session unavailable',
  'hint.no-messages': 'no messages',
  'hint.more-messages': '…and {m} more messages',
  'hint.no-commands': '{name} has no commands',
  'hint.no-skills': '{name} has no skills',
  'hint.command-not-found': 'command not found for {name}',
  'hint.skill-unavailable': 'skill unavailable',
  'hint.no-active-turn': 'no active turn',
  'hint.picker-expired': 'picker expired, retry /to',
  'hint.queue-full': 'queue is full (max 10)',
  'hint.cold-compact': 'session is not running — /compact requires a live session',
  'hint.foreign-bot': "reply to another bot's message",
  'snapshot.overview': 'Sessions: {n} ({m} cold)',
  'snapshot.per-session': '{name} [{status}]: {text}',
  'snapshot.more': '…and {n} more — /as',
  'picker.to-title': 'Where should the next message go?',
  'picker.cmd-title': 'Commands for {name} ({n}):',
  'start.greeting': 'Hi! I mirror your dsh agents. /follow — snapshot and live tracking, /as — session list, /help — help.',
  'start.hint': 'send /follow for a snapshot',
  'history.format': '🤖 {name} · {time}: {text}',
});

const CATALOGS = Object.freeze({ ru: RU, en: EN });
const LANGUAGES = Object.freeze(['ru', 'en']);

export function normalizeLanguage(value) {
  return LANGUAGES.includes(value) ? value : 'en';
}

// Russian plural: 1 -> form0, 2-4 -> form1, 5+ -> form2.
function ruPlural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 14) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

function substitute(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : match
  ));
}

/**
 * Message catalog bound to a language getter (hot-reloadable).
 * @param {() => string} getLanguage - returns 'ru' | 'en' (normalized).
 */
export function createI18n(getLanguage) {
  const language = () => normalizeLanguage(getLanguage());
  return {
    language,
    /** Translate a key with optional placeholder params. */
    t(key, params) {
      const catalog = CATALOGS[language()];
      const template = catalog[key] ?? EN[key] ?? key;
      return substitute(template, params);
    },
    /**
     * Translate a countable key with plural forms.
     * RU: forms = [one, few, many]; EN: forms = [one, other].
     */
    tn(key, n, forms) {
      const catalog = CATALOGS[language()];
      const template = catalog[key] ?? EN[key] ?? key;
      const selected = language() === 'ru'
        ? ruPlural(n, forms)
        : n === 1 ? forms[0] : (forms[1] ?? forms[0]);
      return substitute(template, { ...(typeof n === 'number' ? { n } : {}), ...selected });
    },
  };
}

export const DEFAULT_LANGUAGE = 'en';
export { CATALOGS, LANGUAGES };