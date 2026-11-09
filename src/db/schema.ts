import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Every note the bot created or extended, with the moment it happened. */
export const notesLog = sqliteTable("notes_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").notNull(),
  action: text("action").notNull(),
  path: text("path").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  bytes: integer("bytes").notNull(),
  telegramUserId: text("telegram_user_id"),
});

/** Telegram update ids that were already handled, so nothing runs twice. */
export const processedUpdates = sqliteTable("processed_updates", {
  updateId: text("update_id").primaryKey(),
  processedAt: text("processed_at").notNull(),
  telegramUserId: text("telegram_user_id"),
});

/**
 * Every write of the bot, kept so it can be undone with /undo: an appended
 * block, a created note or an overwritten one.
 */
export const undoLog = sqliteTable("undo_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").notNull(),
  action: text("action").notNull(),
  path: text("path").notNull(),
  title: text("title").notNull(),
  /** The appended block, for the append. */
  block: text("block"),
  /** The content before the write, for the overwrite. */
  previous: text("previous"),
  /** When the write was undone. */
  undoneAt: text("undone_at"),
  telegramUserId: text("telegram_user_id"),
});

/**
 * The summary of every day, so the file of the month can be written again and
 * a day is never summarised twice.
 */
export const dailySummaries = sqliteTable("daily_summaries", {
  date: text("date").primaryKey(),
  file: text("file").notNull(),
  summary: text("summary").notNull(),
  notesCount: integer("notes_count").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * The jobs of the bot: one row per message of the owner.
 *
 * The row is written before the webhook answers Telegram, so an accepted
 * message is a row on disk. The queue in memory only runs the rows; a restart
 * finds them again. The update id is unique, so a repeated update of Telegram
 * is not a second job.
 */
export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  updateId: text("update_id").notNull().unique(),
  payload: text("payload").notNull(),
  /** queued, running, succeeded or failed. */
  state: text("state").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  error: text("error"),
  /** The last sign of life of the run, so a stuck job is visible. */
  heartbeatAt: text("heartbeat_at"),
  telegramUserId: text("telegram_user_id"),
});

/**
 * The settings of every user of the bot, the language for now.
 */
export const userSettings = sqliteTable("user_settings", {
  telegramUserId: text("telegram_user_id").primaryKey(),
  language: text("language").notNull().default("en"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const schema = {
  notesLog,
  processedUpdates,
  undoLog,
  dailySummaries,
  userSettings,
  jobs,
};
