import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { schema } from "./schema.js";

export type Database = {
  client: Client;
  db: LibSQLDatabase<typeof schema>;
};

/** Opens the local SQLite database and makes sure the tables exist. */
export async function createDatabase(filePath: string): Promise<Database> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  const client = createClient({ url: `file:${path.resolve(filePath)}` });
  const db = drizzle(client, { schema });
  await ensureSchema(client);
  return { client, db };
}

/** Creates the tables when they are missing. */
export async function ensureSchema(client: Client): Promise<void> {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS notes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      action TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      telegram_user_id TEXT
    )`,
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS processed_updates (
      update_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      telegram_user_id TEXT
    )`,
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS undo_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      action TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      block TEXT,
      previous TEXT,
      content_hash TEXT,
      undone_at TEXT,
      telegram_user_id TEXT
    )`,
  );
  // A database that was created before the hash existed gets the column here.
  await client.execute("ALTER TABLE undo_log ADD COLUMN content_hash TEXT").catch(() => undefined);
  await client.execute(
    `CREATE TABLE IF NOT EXISTS daily_summaries (
      date TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      summary TEXT NOT NULL,
      notes_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS user_settings (
      telegram_user_id TEXT PRIMARY KEY,
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      update_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      heartbeat_at TEXT,
      telegram_user_id TEXT
    )`,
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
  await client.execute("CREATE INDEX IF NOT EXISTS notes_log_created_at ON notes_log (created_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS undo_log_created_at ON undo_log (created_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, id)");
}
