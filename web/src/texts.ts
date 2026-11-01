/**
 * The texts of the Mini App.
 *
 * The app follows the language of the user in Telegram, so the notes and the
 * texts of the app are in one language.
 */

export type Language = "en" | "ru";

export type Texts = {
  title: string;
  loading: string;
  notesCount: (count: number) => string;
  search: string;
  clearSearch: string;
  summaryOfDay: string;
  days: (count: number) => string;
  openNote: (title: string) => string;
  emptyTitle: string;
  emptyHint: string;
  writeToBot: string;
  notFoundTitle: string;
  notFoundHint: string;
  errorTitle: string;
  retry: string;
  back: string;
  openErrorTitle: string;
};

const en: Texts = {
  title: "Notes",
  loading: "Loading...",
  notesCount: (count) => `${count} ${count === 1 ? "note" : "notes"}`,
  search: "Search the notes",
  clearSearch: "Clear the search",
  summaryOfDay: "Summary of the day",
  days: (count) => `days: ${count}`,
  openNote: (title) => `Open the note ${title}`,
  emptyTitle: "Nothing here yet",
  emptyHint: "Write to the bot in Telegram, and the note will be here.",
  writeToBot: "Write to the bot",
  notFoundTitle: "Nothing found",
  notFoundHint: "Try another word.",
  errorTitle: "Could not load",
  retry: "Try again",
  back: "Back",
  openErrorTitle: "Could not open",
};

const ru: Texts = {
  title: "Заметки",
  loading: "Загружаю...",
  notesCount: (count) => `${count} ${plural(count, "заметка", "заметки", "заметок")}`,
  search: "Поиск по заметкам",
  clearSearch: "Очистить поиск",
  summaryOfDay: "Итоги дня",
  days: (count) => `дней: ${count}`,
  openNote: (title) => `Открыть заметку ${title}`,
  emptyTitle: "Пока пусто",
  emptyHint: "Напиши боту в Telegram, и заметка появится здесь.",
  writeToBot: "Написать боту",
  notFoundTitle: "Ничего не нашлось",
  notFoundHint: "Попробуй другое слово.",
  errorTitle: "Не удалось загрузить",
  retry: "Повторить",
  back: "Назад",
  openErrorTitle: "Не удалось открыть",
};

const CATALOGS: Record<Language, Texts> = { en, ru };

/** The texts of a language. */
export function texts(language: Language): Texts {
  return CATALOGS[language] ?? CATALOGS.en;
}

/** The right word for the number of things. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
