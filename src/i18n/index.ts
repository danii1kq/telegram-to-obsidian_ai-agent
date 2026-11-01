/**
 * The languages of the bot.
 *
 * The default language of the project is English. The owner of the bot can
 * choose another one with the command `/language`, and the choice is kept in
 * the database.
 */

export type Language = "en" | "ru";

export const LANGUAGES: Language[] = ["en", "ru"];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ru: "Русский",
};

export type Messages = {
  help: string;
  statusEmpty: string;
  statusHeader: string;
  statusRunning: (uptime: string) => string;
  statusModel: (model: string, fallback: string) => string;
  statusNotes: (count: number, inVault: number, size: string) => string;
  statusQueue: (count: number) => string;
  statusSummary: (date: string) => string;
  statusTime: (now: string) => string;
  searchUsage: string;
  searchNotFound: (query: string) => string;
  searchHeader: (query: string) => string;
  searchMore: (count: number) => string;
  inboxEmpty: string;
  inboxHeader: (count: number) => string;
  undoNothing: string;
  undoRemoved: (title: string) => string;
  undoRestored: (title: string) => string;
  undoDeleted: (title: string) => string;
  undoNotFound: (title: string) => string;
  undoConfirm: (title: string) => string;
  undoNothingToConfirm: string;
  noteCreated: (title: string) => string;
  noteAppended: (title: string) => string;
  noteUpdated: (title: string) => string;
  summaryReady: (day: string) => string;
  summaryEmpty: (day: string) => string;
  summaryWorking: (day: string) => string;
  errorWrite: string;
  errorSave: string;
  languageCurrent: (language: string) => string;
  languageChanged: (language: string) => string;
  languageUnknown: string;
  languageButton: string;
  /** The label of the button that opens the Mini App. */
  openNotes: string;
  /** The name of a file that came without a caption. */
  attachmentFallback: (name: string) => string;
  /** The title of a note that could not be derived from the message. */
  untitledNote: string;
  /** The answer of the bot when the file is bigger than the limit. */
  fileTooBig: (limit: string) => string;
  /** The uptime of the bot, split into its parts. */
  uptimeDays: (days: number, hours: number) => string;
  uptimeHours: (hours: number, minutes: number) => string;
  uptimeMinutes: (minutes: number) => string;
  /** The size of the vault. */
  size: (bytes: number) => string;
  /** The number of the days of the summaries. */
  daysCount: (count: number) => string;
};

const en: Messages = {
  help: [
    "I turn your thoughts into notes of an Obsidian vault.",
    "",
    "Just send a text - I will find a note about the same topic or create a new one.",
    "When the message needs facts, I go to the web through DuckDuckGo myself.",
    "Tags are written in the message itself: #idea #work.",
    "",
    "Commands:",
    "/start - this message",
    "/status - what has been written",
    "/search query - find a note by a word",
    "/inbox - what is not sorted out yet",
    "/undo - take back my last write",
    "/summary - the summary of yesterday",
    "/language - the language of the bot",
  ].join("\n"),
  statusEmpty: "Nothing has been written yet.",
  statusHeader: "The last notes:",
  statusRunning: (uptime) => `The bot is running for ${uptime}`,
  statusModel: (model, fallback) =>
    fallback ? `• Model: ${model} (reserve ${fallback})` : `• Model: ${model}`,
  statusNotes: (count, inVault, size) => `• Notes: ${count} (in the vault ${inVault}, ${size})`,
  statusQueue: (count) => `• In the queue: ${count}`,
  statusSummary: (date) => `• The last summary: ${date}`,
  statusTime: (now) => `• Time: ${now}`,
  searchUsage: "Write a query: /search coffee",
  searchNotFound: (query) => `Nothing found for "${query}".`,
  searchHeader: (query) => `Found for "${query}":`,
  searchMore: (count) => `and ${count} more`,
  inboxEmpty: "The inbox is empty.",
  inboxHeader: (count) => `In the inbox (${count}):`,
  undoNothing: "There is nothing to undo, I have not written anything.",
  undoRemoved: (title) => `Took my entry out of "${title}".`,
  undoRestored: (title) => `Gave "${title}" its old content back.`,
  undoDeleted: (title) => `Deleted the note "${title}".`,
  undoNotFound: (title) => `My entry is not in "${title}" anymore, I changed nothing.`,
  undoConfirm: (title) =>
    `The note "${title}" was changed after I wrote it. Delete it anyway? Answer /undo confirm.`,
  undoNothingToConfirm: "There is nothing to confirm.",
  noteCreated: (title) => `Created the note "${title}"`,
  noteAppended: (title) => `Added an entry to "${title}"`,
  noteUpdated: (title) => `Updated the note "${title}"`,
  summaryReady: (day) => `The summary of ${day} is ready. It is in the Mini App.`,
  summaryEmpty: (day) => `There were no notes on ${day}, I write no summary.`,
  summaryWorking: (day) => `I am making the summary of ${day}...`,
  errorWrite: "I could not write the note, try once more.",
  errorSave: "I could not save the file, try once more.",
  languageCurrent: (language) => `The language of the bot is now: ${language}.`,
  languageChanged: (language) => `The language of the bot is now: ${language}.`,
  languageUnknown: "I know only English and Russian: /language en or /language ru.",
  languageButton: "Choose the language of the bot",
  openNotes: "Open the notes",
  attachmentFallback: (name) => `File ${name}`,
  untitledNote: "Note",
  fileTooBig: (limit) => `The file is too big, the limit is ${limit}.`,
  uptimeDays: (days, hours) => `${days} d ${hours} h`,
  uptimeHours: (hours, minutes) => `${hours} h ${minutes} min`,
  uptimeMinutes: (minutes) => `${minutes} min`,
  size: (bytes) => formatBytes(bytes, "en-GB"),
  daysCount: (count) => `${count} ${count === 1 ? "day" : "days"}`,
};

const ru: Messages = {
  help: [
    "Я превращаю твои мысли в заметки Obsidian.",
    "",
    "Просто пришли текст - я найду подходящую заметку или создам новую.",
    "Если нужно проверить факты, я сам полезу в интернет через DuckDuckGo.",
    "Теги пиши прямо в сообщении: #идея #работа.",
    "",
    "Команды:",
    "/start - это сообщение",
    "/status - что уже записано",
    "/search запрос - найти заметку по слову",
    "/inbox - что ещё не разобрано",
    "/undo - отменить мою последнюю запись",
    "/summary - итог за вчера",
    "/language - язык бота",
  ].join("\n"),
  statusEmpty: "Пока ничего не записано.",
  statusHeader: "Последние записи:",
  statusRunning: (uptime) => `Бот работает ${uptime}`,
  statusModel: (model, fallback) =>
    fallback ? `• Модель: ${model} (резерв ${fallback})` : `• Модель: ${model}`,
  statusNotes: (count, inVault, size) => `• Заметок: ${count} (в хранилище ${inVault}, ${size})`,
  statusQueue: (count) => `• В очереди: ${count}`,
  statusSummary: (date) => `• Последний итог: ${date}`,
  statusTime: (now) => `• Время: ${now}`,
  searchUsage: "Напиши запрос: /search кофе",
  searchNotFound: (query) => `Ничего не нашлось по запросу «${query}».`,
  searchHeader: (query) => `По запросу «${query}»:`,
  searchMore: (count) => `и ещё ${count}`,
  inboxEmpty: "В инбоксе пусто.",
  inboxHeader: (count) => `В инбоксе (${count}):`,
  undoNothing: "Отменять нечего: последних записей я не делал.",
  undoRemoved: (title) => `Убрал свою запись из «${title}».`,
  undoRestored: (title) => `Вернул прежнее содержимое заметки «${title}».`,
  undoDeleted: (title) => `Удалил заметку «${title}».`,
  undoNotFound: (title) => `Моей записи в «${title}» уже нет, ничего не менял.`,
  undoConfirm: (title) =>
    `Заметку «${title}» меняли после того, как я её создал. Удалить всё равно? Ответь /undo confirm.`,
  undoNothingToConfirm: "Нечего подтверждать.",
  noteCreated: (title) => `Создал заметку «${title}»`,
  noteAppended: (title) => `Добавил запись в «${title}»`,
  noteUpdated: (title) => `Обновил заметку «${title}»`,
  summaryReady: (day) => `Итоги за ${day} готовы. Их можно посмотреть в мини-приложении.`,
  summaryEmpty: (day) => `За ${day} заметок не было, итог не записываю.`,
  summaryWorking: (day) => `Считаю итог за ${day}...`,
  errorWrite: "Не смог записать заметку, попробуй ещё раз.",
  errorSave: "Не смог сохранить файл, попробуй ещё раз.",
  languageCurrent: (language) => `Язык бота теперь: ${language}.`,
  languageChanged: (language) => `Язык бота теперь: ${language}.`,
  languageUnknown: "Я знаю только английский и русский: /language en или /language ru.",
  languageButton: "Выбери язык бота",
  openNotes: "Открыть заметки",
  attachmentFallback: (name) => `Файл ${name}`,
  untitledNote: "Заметка",
  fileTooBig: (limit) => `Файл слишком большой, максимум ${limit}.`,
  uptimeDays: (days, hours) => `${days} д ${hours} ч`,
  uptimeHours: (hours, minutes) => `${hours} ч ${minutes} мин`,
  uptimeMinutes: (minutes) => `${minutes} мин`,
  size: (bytes) => formatBytes(bytes, "ru-RU"),
  daysCount: (count) => `дней: ${count}`,
};

/**
 * The size of the vault in a readable form. The units come from Intl, so the
 * English text says kB and the Russian one says кБ without a table of its own.
 */
function formatBytes(bytes: number, locale: string): string {
  const format = (value: number, unit: "byte" | "kilobyte" | "megabyte") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(value);

  if (bytes < 1024) return format(bytes, "byte");
  if (bytes < 1024 * 1024) return format(bytes / 1024, "kilobyte");
  return format(bytes / (1024 * 1024), "megabyte");
}

const CATALOGS: Record<Language, Messages> = { en, ru };

/** The messages of a language. */
export function messages(language: Language): Messages {
  return CATALOGS[language] ?? CATALOGS.en;
}

/** Is this a language the bot knows? */
export function isLanguage(value: string): value is Language {
  return value === "en" || value === "ru";
}
