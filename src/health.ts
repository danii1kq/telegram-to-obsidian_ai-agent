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

/** The database answers a trivial question. */
async function checkDatabase(db: Database["db"]): Promise<CheckResult> {
  try {
    // `select 1` through drizzle keeps the check on the same connection pool
    // the rest of the process uses, so a pool that is stuck shows up here.
    await db.run("select 1");
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The vault is readable: the folder exists and lists. */
async function checkVault(vault: VaultOperations): Promise<CheckResult> {
  try {
    await vault.listNotes();
    return { ok: true };
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
