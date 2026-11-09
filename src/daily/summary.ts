import { and, eq, gte, lt } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/index.js";
import { dailySummaries, notesLog } from "../db/schema.js";
import type { HermesClient } from "../hermes/client.js";
import { type Language, messages } from "../i18n/index.js";
import type { Logger } from "../logger.js";
import { readEvents } from "../vault/events.js";
import { normalizeDashes, type VaultOperations } from "../vault/operations.js";
import { localDate, localDayStartMs, monthFileName, monthTitle, previousDay } from "./time.js";

export interface DailyDeps {
  config: AppConfig;
  db: Database["db"];
  vault: VaultOperations;
  hermes: HermesClient;
  logger: Logger;
}

export interface DailySummary {
  /** The day the summary is about, `2026-10-21`. */
  day: string;
  /** The file of the month, `october_2026.md`. */
  file: string;
  summary: string;
  notesCount: number;
}

interface DayNote {
  title: string;
  path: string;
  action: string;
  excerpt: string;
}

const MAX_EXCERPT = 700;

/**
 * The toolsets of the agent that writes the summary.
 *
 * The summary is a text about notes that already exist, so the agent needs no
 * tool that touches the vault. The restriction is not a line in the prompt:
 * the prompt is a request, the toolset is the permission. `safe` is the name
 * Hermes uses for the set without the file and the terminal tools.
 */
const SUMMARY_TOOLSETS = "safe";

/**
 * The writes the agent did while it made the summary, taken back.
 *
 * This is kept for the callers that know the exact run: an event is only
 * taken back when its `runId` is the one of the run that is being undone. An
 * event without a run id is never touched, because there is no way to tell
 * whose it is.
 *
 * The summary itself does not use it any more. The agent of the summary has no
 * write tools, so there is nothing to take back, and a revert that guesses by
 * time deletes the notes of other jobs: a note written a second before the
 * summary starts is inside any window that is wide enough to catch a stray
 * write of the summary.
 */
export async function revertStrayWrites(
  vault: VaultOperations,
  eventsFile: string,
  runId: string,
): Promise<number> {
  if (!runId) return 0;
  const events = await readEvents(eventsFile);
  const stray = events.filter((event) => event.runId === runId);
  let reverted = 0;

  for (const event of [...stray].reverse()) {
    try {
      if (event.action === "append" && event.block) {
        await vault.removeBlock(event.path, event.block);
        reverted += 1;
      } else if (event.action === "overwrite" && event.previous !== undefined) {
        await vault.writeNote(event.path, event.previous, { source: "agent", autoLink: false });
        reverted += 1;
      } else if (event.action === "create") {
        await vault.deleteNote(event.path);
        reverted += 1;
      }
    } catch {
      // The file is gone or locked, the next write will not find it anyway.
    }
  }
  return reverted;
}

/**
 * Makes the summary of a day and writes it into the file of the month.
 *
 * Nothing happens when the owner did not write anything that day: the day is
 * simply missing in the file of the month.
 */
export async function runDailySummary(
  deps: DailyDeps,
  day: string,
  language: Language = "ru",
): Promise<DailySummary | null> {
  const notes = await collectNotesOfDay(deps, day);
  if (notes.length === 0) {
    deps.logger.info("no notes that day, the summary is skipped", { day });
    return null;
  }

  const existing = await deps.db
    .select()
    .from(dailySummaries)
    .where(eq(dailySummaries.date, day))
    .limit(1);
  if (existing.length > 0) {
    deps.logger.info("the summary of the day exists already", { day });
    return null;
  }

  const prompt = buildSummaryPrompt(day, notes, language);
  // The agent of the summary has no tool that writes: the summary is a text
  // about notes that already exist. The restriction is the toolset, not a
  // line in the prompt, and there is no revert afterwards: a revert that
  // picks the writes by time deletes the notes of the jobs around it.
  const run = await deps.hermes.run(prompt, { toolsets: SUMMARY_TOOLSETS });
  if (!run.ok) {
    deps.logger.error("the agent did not make the summary", { day, error: run.error });
    return null;
  }

  const summary = cleanSummary(run.text);
  if (!summary) {
    deps.logger.warn("the summary of the day is empty", { day });
    return null;
  }

  const file = await writeSection(deps.vault, day, summary, language);
  await deps.db.insert(dailySummaries).values({
    date: day,
    file,
    summary,
    notesCount: notes.length,
    createdAt: new Date().toISOString(),
  });

  deps.logger.info("the summary of the day is written", { day, file, notes: notes.length });
  return { day, file, summary, notesCount: notes.length };
}

/**
 * Makes the summaries that are missing after a restart.
 *
 * The days are taken from the oldest to the newest, so the sections of the
 * file of the month stay in the right order.
 */
export async function catchUpDailySummaries(
  deps: DailyDeps,
  days = 3,
  language: Language = "ru",
): Promise<DailySummary[]> {
  const today = localDate(new Date(), deps.config.vault.timeZone);
  const wanted: string[] = [];
  let day = today;
  for (let counter = 0; counter < days; counter += 1) {
    day = previousDay(day);
    wanted.unshift(day);
  }

  const summaries: DailySummary[] = [];
  for (const wantedDay of wanted) {
    const summary = await runDailySummary(deps, wantedDay, language);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** The notes the owner wrote during a day. */
export async function collectNotesOfDay(deps: DailyDeps, day: string): Promise<DayNote[]> {
  const timeZone = deps.config.vault.timeZone;
  const start = new Date(localDayStartMs(day, timeZone)).toISOString();
  const end = new Date(localDayStartMs(nextDay(day), timeZone)).toISOString();

  const rows = await deps.db
    .select()
    .from(notesLog)
    .where(and(gte(notesLog.createdAt, start), lt(notesLog.createdAt, end)))
    .orderBy(notesLog.id);

  const notes: DayNote[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    const file = await deps.vault.readFile(row.path).catch(() => null);
    notes.push({
      title: row.title,
      path: row.path,
      action: row.action,
      excerpt: file ? excerptOf(file.content) : "",
    });
  }

  return notes;
}

/** The notice of the chat: the summary is ready, it is in the Mini App. */
export interface SummaryNotice {
  text: string;
  /** The address of the Mini App, when it is known. */
  miniAppUrl?: string;
}

/**
 * The short message of the chat.
 *
 * The whole summary is in the file of the month and in the Mini App, the chat
 * only says that it is ready.
 */
export function summaryNotice(
  day: string,
  miniAppUrl?: string,
  language: Language = "ru",
): SummaryNotice {
  const text = messages(language).summaryReady(day);
  return {
    text,
    ...(miniAppUrl ? { miniAppUrl } : {}),
  };
}

/** The next day of a day, `2026-10-21` -> `2026-10-22`. */
function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const stamp = Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + 1);
  const next = new Date(stamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The text of a note without the frontmatter, shortened. */
function excerptOf(content: string): string {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const text = withoutFrontmatter.trim();
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}...` : text;
}

/** The prompt of the agent that makes the summary. */
export function buildSummaryPrompt(
  day: string,
  notes: DayNote[],
  language: Language = "ru",
): string {
  const list = notes
    .map((note, index) => {
      const parts = [`${index + 1}. Заметка «${note.title}» (${note.path})`];
      if (note.excerpt) parts.push(note.excerpt);
      return parts.join("\n");
    })
    .join("\n\n");

  if (language === "en") {
    return [
      `You keep the daily journal of the owner. Below are the notes they wrote on ${day}.`,
      "",
      list,
      "",
      "Write the summary of that day from these notes:",
      "list the notes of the day and say in one or two sentences what is written in each of them.",
      "Write plain English, one note per line.",
      "Only what is in the notes, do not invent anything and do not add anything of your own.",
      "No headers, no long dashes.",
      "Do not write anything into the vault, answer with the text of the summary only.",
    ].join("\n");
  }

  return [
    `Ты ведёшь ежедневный журнал владельца. Ниже заметки, которые он записал за ${day}.`,
    "",
    list,
    "",
    "Напиши итог за этот день по этим заметкам:",
    "перечисли заметки дня и о каждой скажи в одной-двух фразах, что именно в ней записано.",
    "Пиши по-русски, простым текстом, каждый день с новой строки.",
    "Только то, что есть в заметках, ничего не выдумывай и не добавляй ничего от себя.",
    "Без заголовков, без длинных тире.",
    "Ничего не записывай в хранилище, ответь только текстом итога.",
  ].join("\n");
}

/** Cleans the answer of the agent: no quotes, no long dashes, no headers. */
export function cleanSummary(text: string): string {
  const cleaned = normalizeDashes(text)
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/, "")
    .replace(/^(вывод|итог|резюме)\s*[:—-]\s*/i, "")
    .replace(/^#+\s*/gm, "")
    .trim();

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const text2 = lines
    .join("\n")
    .replace(/^["']|["']$/g, "")
    .trim();
  return text2.length > 3000 ? `${text2.slice(0, 2997)}...` : text2;
}

/**
 * Writes the section of a day into the file of the month.
 *
 * The file of the month holds one section per day. A day that comes again
 * replaces its own section, the other days stay as they are.
 */
export async function writeSection(
  vault: VaultOperations,
  day: string,
  summary: string,
  language: Language = "ru",
): Promise<string> {
  const file = monthFileName(day);
  const section = `## ${day}\n\n${summary}`;
  const current = await vault.readFile(file).catch(() => null);

  if (!current) {
    const header = `---\ndate: ${day.slice(0, 7)}-01\ntags: [journal, daily]\n---\n\n# ${monthTitle(day, language)}\n`;
    await vault.writeNote(file, `${header}\n${section}`, { source: "agent", autoLink: false });
    return file;
  }
  const content = current.content;
  const heading = `## ${day}`;
  const index = content.indexOf(heading);
  if (index < 0) {
    await vault.appendNote(file, `\n${section}`, { source: "agent" });
    return file;
  }

  const nextHeading = content.indexOf("\n## ", index + heading.length);
  const end = nextHeading < 0 ? content.length : nextHeading;
  const next = `${content.slice(0, index)}${section}\n${content.slice(end).replace(/^\n+/, "")}`;
  await vault.writeNote(file, next, { source: "agent", autoLink: false });
  return file;
}
