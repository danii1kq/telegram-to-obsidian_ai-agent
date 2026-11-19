import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { jobs, meta } from "../db/schema.js";
import type { Logger } from "../logger.js";

/**
 * The durable inbox of the bot.
 *
 * A message of the owner is a job in the database before the webhook answers
 * Telegram. The queue in memory is only the thing that runs the jobs: if the
 * process dies, the jobs are still there, and the next start picks up the ones
 * that were queued or running.
 *
 * The states are `queued`, `running`, `succeeded` and `failed`. A job that was
 * running when the process died is put back into the queue, because there is
 * no way to know whether its write landed: the vault is the record of what
 * happened, and the pipeline reads it to decide what to report.
 */

export type JobState = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface JobRecord {
  id: number;
  /** The update of Telegram, unique, so a repeated update is not a new job. */
  updateId: string;
  /** The message of the owner, as it came. */
  payload: string;
  state: JobState;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The last error, when the job failed. */
  error: string | null;
  /** The heartbeat of the run, so a stuck job is visible. */
  heartbeatAt: string | null;
}

/** How many times a job is tried before it is given up. */
const MAX_ATTEMPTS = 3;

/** A job that has not sent a heartbeat for this long is stuck. */
export const STUCK_JOB_MS = 15 * 60_000;

/** The mark that the jobs of an older version were already dealt with. */
const LEGACY_MARK = "jobs.legacy-migrated";

export interface InboxOptions {
  db: Database["db"];
  logger: Logger;
  /** The current moment, for the tests. */
  now?: () => number;
}

export class Inbox {
  private readonly db: Database["db"];
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: InboxOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Accepts a job and says whether it is new.
   *
   * The row is written before the webhook answers Telegram, so an update that
   * was accepted is a row in the database. A repeated update id is not a new
   * job: it comes back as `created: false` and the caller answers Telegram
   * without running anything twice.
   */
  async accept(input: {
    updateId: string;
    payload: string;
    telegramUserId?: string;
  }): Promise<{ created: boolean; job: JobRecord | null }> {
    const at = new Date(this.now()).toISOString();
    const inserted = await this.db
      .insert(jobs)
      .values({
        updateId: input.updateId,
        payload: input.payload,
        state: "queued",
        attempts: 0,
        createdAt: at,
        telegramUserId: input.telegramUserId ?? null,
      })
      .onConflictDoNothing()
      .returning();

    const row = inserted[0];
    if (row) return { created: true, job: toRecord(row) };

    // The update is known already. It may be a retry of Telegram, or a job
    // that failed and is waiting for its next attempt.
    const existing = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.updateId, input.updateId))
      .limit(1);
    const found = existing[0];
    return { created: false, job: found ? toRecord(found) : null };
  }

  /** The jobs that still have to run, the oldest first. */
  async pending(limit = 100): Promise<JobRecord[]> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(inArray(jobs.state, ["queued", "running"]))
      .orderBy(asc(jobs.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  /**
   * Takes a job for a run.
   *
   * The job is marked as running with the moment of the start and a heartbeat,
   * so a job that stops moving is visible from the outside. A job that is
   * already running is not taken twice.
   */
  async start(id: number): Promise<JobRecord | null> {
    const at = new Date(this.now()).toISOString();
    const updated = await this.db
      .update(jobs)
      .set({
        state: "running",
        startedAt: at,
        heartbeatAt: at,
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(and(eq(jobs.id, id), inArray(jobs.state, ["queued", "running"])))
      .returning();
    const row = updated[0];
    return row ? toRecord(row) : null;
  }

  /** Says that the job is still moving. */
  async heartbeat(id: number): Promise<void> {
    await this.db
      .update(jobs)
      .set({ heartbeatAt: new Date(this.now()).toISOString() })
      .where(eq(jobs.id, id));
  }

  /** Says that the job is done. */
  async succeed(id: number): Promise<void> {
    await this.db
      .update(jobs)
      .set({ state: "succeeded", finishedAt: new Date(this.now()).toISOString(), error: null })
      .where(eq(jobs.id, id));
  }

  /**
   * Says that the job failed.
   *
   * A job that still has attempts left goes back to the queue, so a failure of
   * one run does not lose the message. A job that used all of them stays
   * failed, with the error, and the owner is told.
   */
  async fail(id: number, error: string): Promise<{ retry: boolean }> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    const row = rows[0];
    if (!row) return { retry: false };

    const retry = row.attempts < MAX_ATTEMPTS;
    await this.db
      .update(jobs)
      .set({
        state: retry ? "queued" : "failed",
        error: error.slice(0, 2000),
        ...(retry ? {} : { finishedAt: new Date(this.now()).toISOString() }),
      })
      .where(eq(jobs.id, id));
    return { retry };
  }

  /**
   * The jobs that were running when the process stopped.
   *
   * They are put back into the queue: the process that ran them is gone, and
   * nothing else will ever finish them. The pipeline reads the vault to decide
   * what actually happened, so a job whose write landed is reported as done
   * instead of being written twice.
   */
  async recover(): Promise<JobRecord[]> {
    const at = new Date(this.now()).toISOString();
    const rows = await this.db
      .update(jobs)
      .set({ state: "queued", heartbeatAt: at })
      .where(eq(jobs.state, "running"))
      .returning();
    if (rows.length > 0) {
      this.logger.warn("the jobs of the previous run are back in the queue", {
        count: rows.length,
      });
    }
    return rows.map(toRecord);
  }

  /**
   * Marks the jobs of an older version as interrupted, once.
   *
   * Before this version the webhook answered Telegram and then handled the
   * update in the same call, so a row in `queued` or `running` is a leftover of
   * a process that stopped in the middle: the message was already handled, or
   * it was not, and there is no way to tell. Running them again would write a
   * note twice and would repeat an `/undo`, so they are kept with their payload
   * and marked as interrupted, where the owner can see them.
   *
   * The mark is written into `meta`, so the migration runs once. The jobs that
   * this version queues are left alone on every later start.
   */
  async migrateLegacyJobs(): Promise<number> {
    const marker = await this.db.select().from(meta).where(eq(meta.key, LEGACY_MARK)).limit(1);
    if (marker.length > 0) return 0;

    const at = new Date(this.now()).toISOString();
    const rows = await this.db
      .update(jobs)
      .set({ state: "interrupted", finishedAt: at, heartbeatAt: at })
      .where(inArray(jobs.state, ["queued", "running"]))
      .returning({ id: jobs.id });

    await this.db
      .insert(meta)
      .values({ key: LEGACY_MARK, value: at })
      .onConflictDoNothing();

    if (rows.length > 0) {
      this.logger.warn("the jobs of an older version are marked as interrupted", {
        count: rows.length,
      });
    }
    return rows.length;
  }

  /**
   * The age of the oldest job that is running.
   *
   * The health check uses it: a job that has been running for an hour with no
   * heartbeat is a stuck process, and a green health check would hide it.
   */
  async oldestRunningAgeMs(): Promise<number | null> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.state, "running"))
      .orderBy(asc(jobs.id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const since = Date.parse(row.heartbeatAt ?? row.startedAt ?? row.createdAt);
    if (!Number.isFinite(since)) return null;
    return Math.max(0, this.now() - since);
  }

  /** How many jobs wait. */
  async queuedCount(): Promise<number> {
    const rows = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(jobs)
      .where(inArray(jobs.state, ["queued", "running"]));
    return Number(rows[0]?.value ?? 0);
  }

  /**
   * Throws away the jobs that are done and old.
   *
   * The table is not a history of the bot: the log of the notes is. Keeping
   * every update forever grows the database with rows nobody reads.
   */
  async prune(olderThanMs: number): Promise<number> {
    const before = new Date(this.now() - olderThanMs).toISOString();
    const removed = await this.db
      .delete(jobs)
      .where(
        and(
          inArray(jobs.state, ["succeeded", "failed"]),
          or(lt(jobs.finishedAt, before), lt(jobs.createdAt, before)),
        ),
      )
      .returning({ id: jobs.id });
    return removed.length;
  }
}

/** The row of the database as the record the bot works with. */
function toRecord(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    updateId: row.updateId,
    payload: row.payload,
    state: row.state as JobState,
    attempts: row.attempts,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    heartbeatAt: row.heartbeatAt,
  };
}
