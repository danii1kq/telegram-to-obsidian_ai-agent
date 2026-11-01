import { readdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { Database } from "./db/index.js";
import type { Logger } from "./logger.js";
import type { VaultOperations } from "./vault/operations.js";

/**
 * The health of the process.
 *
 * A health endpoint that answers `ok` because the process is alive is worth
 * nothing: the container is restarted when the bot stopped working, not when
 * the event loop stopped. The checks below are the things that actually break:
 * the database, the vault and the queue.
 */

export interface HealthDeps {
  db: Database["db"];
  vault: VaultOperations;
  logger: Logger;
  /** How many messages wait in the queue. */
  queueSize: () => number;
  /** The moment of the last message that went through the pipeline. */
  lastMessageAt: () => number | null;
  /** The moment the process started. */
  startedAt: number;
  /** The current moment, for the tests. */
  now?: () => number;
}

export interface HealthReport {
  ok: boolean;
  service: string;
  uptimeSeconds: number;
  checks: {
    database: CheckResult;
    vault: CheckResult;
    queue: CheckResult;
  };
}

export interface CheckResult {
  ok: boolean;
  detail?: string;
}

/** A message that waits longer than this is a queue that does not move. */
const MAX_QUEUE_SIZE = 50;

/** The database answers a question about a real table. */
async function checkDatabase(db: Database["db"]): Promise<CheckResult> {
  try {
    // `select 1` is answered by the engine without touching a file, so it stays
    // green on a database whose file is gone. The question goes to a table the
    // bot actually writes, which is what breaks when the file does.
    await db.run(sql`select count(*) from notes_log`);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The vault is readable.
 *
 * `listNotes` swallows a folder it cannot read and answers with an empty list,
 * which is right for a scan and wrong for a health check: a vault that is gone
 * looks like an empty vault. The check reads the folder itself.
 */
async function checkVault(vault: VaultOperations): Promise<CheckResult> {
  try {
    const entries = await readdir(vault.vaultRoot, { withFileTypes: true });
    return { ok: true, detail: `${entries.length} entries` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The queue is not backing up. */
function checkQueue(size: number): CheckResult {
  if (size <= MAX_QUEUE_SIZE) return { ok: true };
  return { ok: false, detail: `${size} messages are waiting` };
}

/** Builds the report of one health call. */
export async function healthReport(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now?.() ?? Date.now();
  const [database, vault] = await Promise.all([checkDatabase(deps.db), checkVault(deps.vault)]);
  const queue = checkQueue(deps.queueSize());

  const checks = { database, vault, queue };
  const ok = Object.values(checks).every((check) => check.ok);

  if (!ok) {
    deps.logger.warn("the health check failed", {
      database: database.ok ? "ok" : database.detail,
      vault: vault.ok ? "ok" : vault.detail,
      queue: queue.ok ? "ok" : queue.detail,
    });
  }

  return {
    ok,
    service: "telegram-to-obsidian-ai-agent",
    uptimeSeconds: Math.max(0, Math.round((now - deps.startedAt) / 1000)),
    checks,
  };
}
