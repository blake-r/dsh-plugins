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
  'status.header': 'Сессии ({n}):',
  'not-yet': 'Команда {cmd} ещё в разработке.',
  'list.as-header': 'Сессии ({n}):',
  'list.ps-header': 'Пресеты ({n}):',
  'list.ws-header': 'Рабочие пространства ({n}):',
  'list.ws-drilldown': 'Сессии workspace «{title}» ({n}):',
  'list.ps-drilldown': 'Пресет «{name}» — сессии ({n}):',
  'hint.drilldown-miss': 'Не найдено (слаг устарел — обновите меню).',
  'hint.no-recipient': 'Отвечайте на сообщение сессии (reply) или укажите адресата через /to, либо выведите историю сессии — /hs — и ответьте на неё',
  'hint.reply-or-to': 'reply на сообщение сессии или /to',
  'hint.text-only': 'только текстовые сообщения',
  'hint.follow-off': 'follow-режим выключен, включите /follow',
  'hint.follow-not-on': 'follow не включён',
  'hint.follow-on': 'Зеркало включено: снапшот отправлен, живое отслеживание активно.',
  'hint.follow-usage': 'Использование: /follow (или /follow on) — включить зеркало; /unfollow (или /follow off) — выключить.',
  'hint.cmd-reply': 'reply на сообщение сессии, затем /cmd или /skill',
  'hint.interaction-done': 'интеракция уже обработана',
  'hint.session-gone': 'сессия недоступна',
  'hint.no-messages': 'сообщений нет',
  'hint.more-messages': '…ещё {m} сообщений',
  'hint.hs-usage': 'reply на сообщение сессии, или /hs <номер из /as> [число сообщений]',
  'hint.no-commands': 'у {name} нет команд',
  'hint.no-skills': 'у {name} нет скиллов',
  'hint.command-not-found': 'команда не найдена у {name}',
  'hint.skill-unavailable': 'скилл недоступен',
  'hint.no-active-turn': 'нет активного хода',
  'hint.stop-ok': 'Ход сессии {name} остановлен (очередь сохранена).',
  'hint.picker-expired': 'пикер истёк, повторите /to',
  'hint.queue-full': 'очередь переполнена (максимум 10)',
  'hint.cold-compact': 'сессия не запущена — /compact требует живой сессии',
  'hint.compact-nothing': 'Нечего сжимать.',
  'hint.compact-ok': 'Сжато {n} записей истории.',
  'hint.new-prompt-required': '/new требует промт: /new [workspace] [preset] <промт>',
  'hint.new-workspace-required': 'Укажите рабочее пространство: /new <ws> <промт> (или дефолт в настройках бота)',
  'hint.new-create-failed': 'Не удалось создать сессию.',
  'hint.new-followup-failed': 'Сессия {name} создана, но первый запрос не отправлен.',
  'hint.new-ok': 'Сессия {name} создана, первый запрос отправлен.',
  'hint.alias-invalid': 'Алиас: только a-z, 0-9, _ и а-яё, до 32 символов.',
  'hint.alias-taken': 'Алиас занят (команда, слаг или алиас другой сессии).',
  'hint.alias-ok': 'Алиас "{alias}" сохранён.',
  'hint.foreign-bot': 'reply на сообщение чужого бота',
  'snapshot.overview': 'Сессий: {n} ({m} холодных)',
  'snapshot.per-session': '{name} [{status}]: {text}',
  'snapshot.more': '…и ещё {n} — /as',
  'picker.to-title': 'Куда отправить следующее сообщение?',
  'picker.cmd-title': 'Команды {name} ({n}):',
  'picker.skill-title': 'Скиллы {name} ({n}):',
  'picker.target-set': 'Следующее сообщение пойдёт агенту {name}.',
  'start.greeting': 'Привет! Я зеркало ваших dsh-агентов. /follow — снапшот и живое отслеживание, /as — список сессий, /help — справка.',
  'start.hint': 'напишите /follow для снапшота',
  'history.format': '🤖 {name} · {time}: {text}',
  'menu.new': 'создать сессию',
  'menu.as': 'список сессий',
  'menu.ws': 'рабочие пространства',
  'menu.ps': 'пресеты',
  'menu.hs': 'история сессии',
  'menu.follow': 'включить зеркало',
  'menu.unfollow': 'выключить зеркало',
  'menu.stop': 'остановить ход',
  'menu.steer': 'перенаправить ход',
  'menu.enqueue': 'в очередь',
  'menu.to': 'выбрать адресата',
  'menu.help': 'справка',
  'menu.ws-section': 'сессии workspace',
  'menu.ps-section': 'информация о пресете',
  'menu.ws-sessions': 'Сессии {workspace} ({n}):',
  'menu.ps-info': '{name} [{id}]: {description}',
  'interaction.approval-title': 'DeepSeek Harness требует вашего одобрения:',
  'interaction.tool': 'Инструмент: {tool}',
  'interaction.operation-params': 'Параметры операции:',
  'interaction.reason': 'Причина: {reason}',
  'interaction.approval-prompt': 'Ответьте точно «одобрить» или «отклонить» (также: да / подтверждаю / разрешаю / нет / отклонить / запрещаю / yes / no).',
  'interaction.mention-approval': 'В групповом чате @упомяните бота перед решением об одобрении.',
  'interaction.approval-allowed': 'Одобрено, действует только для этой операции.',
  'interaction.approval-rejected': 'Операция отклонена.',
  'interaction.approval-actor-only': 'Только инициатор текущей задачи может обработать это одобрение.',
  'interaction.approval-after-question': 'Сначала ответьте на текущий вопрос, затем точно «одобрить» или «отклонить».',
  'interaction.approval-resolved': 'Это одобрение уже обработано, повторный ответ не нужен.',
  'interaction.approval-submitting': 'Решение отправляется, подождите.',
  'interaction.approval-unrenderable': 'Не удалось полностью показать операцию, одобрение безопасно отклонено.',
  'interaction.approval-submit-failed': 'Не удалось отправить решение, повторите «одобрить» или «отклонить».',
  'interaction.question-title': 'DeepSeek Harness нужны дополнительные данные{progress}:',
  'interaction.question-empty': 'Введите ваш ответ.',
  'interaction.question-options-multi': 'Ответьте номером варианта или текстом; для множественного выбора разделите запятыми, можно дополнить.',
  'interaction.question-options-single': 'Ответьте номером варианта или текстом, можно ввести свой ответ.',
  'interaction.question-free': 'Просто ответьте текстом.',
  'interaction.question-mention': 'В групповом чате @упомяните бота перед отправкой ответа.',
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
  'status.header': 'Sessions ({n}):',
  'not-yet': 'Command {cmd} is not implemented yet.',
  'list.as-header': 'Sessions ({n}):',
  'list.ps-header': 'Presets ({n}):',
  'list.ws-header': 'Workspaces ({n}):',
  'list.ws-drilldown': 'Workspace "{title}" sessions ({n}):',
  'list.ps-drilldown': 'Preset "{name}" — sessions ({n}):',
  'hint.drilldown-miss': 'Not found (stale slug — refresh the menu).',
  'hint.no-recipient': 'Reply to a session message, or pick a recipient with /to, or view session history with /hs and reply to it',
  'hint.reply-or-to': 'reply to a session message or use /to',
  'hint.text-only': 'text messages only',
  'hint.follow-off': 'follow mode is off — enable it with /follow',
  'hint.follow-not-on': 'follow is not enabled',
  'hint.follow-on': 'Mirror on: snapshot sent, live tracking active.',
  'hint.follow-usage': 'Usage: /follow (or /follow on) — enable mirroring; /unfollow (or /follow off) — disable it.',
  'hint.cmd-reply': 'reply to a session message, then use /cmd or /skill',
  'hint.interaction-done': 'interaction already handled',
  'hint.session-gone': 'session unavailable',
  'hint.no-messages': 'no messages',
  'hint.more-messages': '…and {m} more messages',
  'hint.hs-usage': 'Reply to a session message, or /hs <number from /as> [message count]',
  'hint.no-commands': '{name} has no commands',
  'hint.no-skills': '{name} has no skills',
  'hint.command-not-found': 'command not found for {name}',
  'hint.skill-unavailable': 'skill unavailable',
  'hint.no-active-turn': 'no active turn',
  'hint.stop-ok': 'Turn of {name} stopped (queue kept).',
  'hint.picker-expired': 'picker expired, retry /to',
  'hint.queue-full': 'queue is full (max 10)',
  'hint.cold-compact': 'session is not running — /compact requires a live session',
  'hint.compact-nothing': 'Nothing to compact.',
  'hint.compact-ok': 'Compacted {n} history items.',
  'hint.new-prompt-required': '/new requires a prompt: /new [workspace] [preset] <prompt>',
  'hint.new-workspace-required': 'Choose a workspace: /new <ws> <prompt> (or set the bot default)',
  'hint.new-create-failed': 'Failed to create the session.',
  'hint.new-followup-failed': 'Session {name} was created, but the first prompt was not sent.',
  'hint.new-ok': 'Session {name} created, first prompt sent.',
  'hint.alias-invalid': 'Alias: only a-z, 0-9, _ and а-яё, up to 32 characters.',
  'hint.alias-taken': 'Alias is taken (a command, a slug, or another session alias).',
  'hint.alias-ok': 'Alias "{alias}" saved.',
  'hint.foreign-bot': "reply to another bot's message",
  'snapshot.overview': 'Sessions: {n} ({m} cold)',
  'snapshot.per-session': '{name} [{status}]: {text}',
  'snapshot.more': '…and {n} more — /as',
  'picker.to-title': 'Where should the next message go?',
  'picker.cmd-title': 'Commands for {name} ({n}):',
  'picker.skill-title': 'Skills for {name} ({n}):',
  'picker.target-set': 'The next message goes to {name}.',
  'start.greeting': 'Hi! I mirror your dsh agents. /follow — snapshot and live tracking, /as — session list, /help — help.',
  'start.hint': 'send /follow for a snapshot',
  'history.format': '🤖 {name} · {time}: {text}',
  'menu.new': 'create a session',
  'menu.as': 'list sessions',
  'menu.ws': 'workspaces',
  'menu.ps': 'presets',
  'menu.hs': 'session history',
  'menu.follow': 'enable mirroring',
  'menu.unfollow': 'disable mirroring',
  'menu.stop': 'stop the turn',
  'menu.steer': 'redirect the turn',
  'menu.enqueue': 'queue a message',
  'menu.to': 'pick a recipient',
  'menu.help': 'help',
  'menu.ws-section': 'workspace sessions',
  'menu.ps-section': 'preset info',
  'menu.ws-sessions': 'Sessions of {workspace} ({n}):',
  'menu.ps-info': '{name} [{id}]: {description}',
  'interaction.approval-title': 'DeepSeek Harness needs your approval:',
  'interaction.tool': 'Tool: {tool}',
  'interaction.operation-params': 'Operation parameters:',
  'interaction.reason': 'Reason: {reason}',
  'interaction.approval-prompt': 'Reply exactly "approve" or "reject" (also: yes / confirm / allow / no / deny / forbid).',
  'interaction.mention-approval': 'In group chats, @mention the bot before sending an approval decision.',
  'interaction.approval-allowed': 'Approved, valid for this operation only.',
  'interaction.approval-rejected': 'Operation rejected.',
  'interaction.approval-actor-only': 'Only the initiator of the current task can handle this approval.',
  'interaction.approval-after-question': 'Answer the current question first, then reply exactly "approve" or "reject".',
  'interaction.approval-resolved': 'This approval has already been handled, no need to reply again.',
  'interaction.approval-submitting': 'Submitting your decision, please wait.',
  'interaction.approval-unrenderable': 'Could not fully display this operation; the approval has been safely rejected.',
  'interaction.approval-submit-failed': 'Failed to submit the decision, reply "approve" or "reject" again.',
  'interaction.question-title': 'DeepSeek Harness needs more information{progress}:',
  'interaction.question-empty': 'Enter your answer.',
  'interaction.question-options-multi': 'Reply with an option number or text; separate multiple choices with commas, you may add more.',
  'interaction.question-options-single': 'Reply with an option number or text, or type your own answer.',
  'interaction.question-free': 'Just reply with your answer.',
  'interaction.question-mention': 'In group chats, @mention the bot before sending your answer.',
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