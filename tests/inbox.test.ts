import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Inbox } from "../src/bot/inbox.js";
import { createDatabase } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("error", "test");

async function makeInbox() {
  const root = await mkdtemp(path.join(tmpdir(), "inbox-"));
  const file = path.join(root, "app.db");
  const { client, db } = await createDatabase(file);
  const inbox = new Inbox({ db, logger });
  return { root, file, client, db, inbox };
}

describe("A07: the durable inbox", () => {
  it("keeps an accepted job on disk", async () => {
    const { client, inbox } = await makeInbox();

    const { created, job } = await inbox.accept({
      updateId: "1001",
      payload: "a thought of the owner",
      telegramUserId: "42",
    });

    expect(created).toBe(true);
    expect(job?.state).toBe("queued");
    expect(job?.payload).toBe("a thought of the owner");

    const pending = await inbox.pending();
    expect(pending.map((row) => row.updateId)).toEqual(["1001"]);
    client.close();
  });

  it("does not accept the same update twice", async () => {
    const { client, inbox } = await makeInbox();

    const first = await inbox.accept({ updateId: "1001", payload: "one" });
    const second = await inbox.accept({ updateId: "1001", payload: "one" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await inbox.pending()).toHaveLength(1);
    client.close();
  });

  it("finds the job again after a restart", async () => {
    const { file, client, inbox } = await makeInbox();
    await inbox.accept({ updateId: "1001", payload: "a thought" });
    await inbox.accept({ updateId: "1002", payload: "another thought" });
    client.close();

    // A new process opens the same file: the jobs are still there.
    const reopened = await createDatabase(file);
    const afterRestart = new Inbox({ db: reopened.db, logger });
    const pending = await afterRestart.pending();

    expect(pending.map((row) => row.updateId)).toEqual(["1001", "1002"]);
    reopened.client.close();
  });

  it("puts a job that was running at the crash back into the queue", async () => {
    const { file, client, inbox } = await makeInbox();
    const { job } = await inbox.accept({ updateId: "1001", payload: "a thought" });
    await inbox.start(job?.id ?? 0);
    client.close();

    // The process died while the job was running. The next start recovers it.
    const reopened = await createDatabase(file);
    const afterRestart = new Inbox({ db: reopened.db, logger });
    const recovered = await afterRestart.recover();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.state).toBe("queued");
    expect(await afterRestart.pending()).toHaveLength(1);
    reopened.client.close();
  });

  it("tries a failed job again and gives up after the limit", async () => {
    const { client, inbox } = await makeInbox();
    const { job } = await inbox.accept({ updateId: "1001", payload: "a thought" });
    const id = job?.id ?? 0;

    // Three attempts, each one fails: the job goes back to the queue twice and
    // stays failed on the third.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await inbox.start(id);
      const result = await inbox.fail(id, `attempt ${attempt} failed`);
      expect(result.retry).toBe(attempt < 3);
    }

    const pending = await inbox.pending();
    expect(pending).toHaveLength(0);
    client.close();
  });

  it("counts the jobs that wait", async () => {
    const { client, inbox } = await makeInbox();
    await inbox.accept({ updateId: "1001", payload: "one" });
    await inbox.accept({ updateId: "1002", payload: "two" });

    expect(await inbox.queuedCount()).toBe(2);
    client.close();
  });

  it("reports the age of a job that stopped moving", async () => {
    const { client, inbox } = await makeInbox();
    const { job } = await inbox.accept({ updateId: "1001", payload: "one" });
    await inbox.start(job?.id ?? 0);

    // The job is running and its heartbeat is fresh.
    const fresh = await inbox.oldestRunningAgeMs();
    expect(fresh).not.toBeNull();
    expect(fresh ?? 0).toBeLessThan(1000);
    client.close();
  });

  it("throws away the jobs that are done and old", async () => {
    const { client, inbox } = await makeInbox();
    const { job } = await inbox.accept({ updateId: "1001", payload: "one" });
    await inbox.start(job?.id ?? 0);
    await inbox.succeed(job?.id ?? 0);

    // Nothing is old yet.
    expect(await inbox.prune(60_000)).toBe(0);
    // Everything older than the epoch is old.
    expect(await inbox.prune(-1)).toBe(1);
    client.close();
  });

  it("marks the jobs of an older version as interrupted, once", async () => {
    const { file, client, inbox } = await makeInbox();
    await inbox.accept({ updateId: "1001", payload: "an old thought" });
    const { job } = await inbox.accept({ updateId: "1002", payload: "another old thought" });
    await inbox.start(job?.id ?? 0);
    client.close();

    // The first start after the update: the rows of the older version are not
    // run again, because the message may already be handled.
    const reopened = await createDatabase(file);
    const afterRestart = new Inbox({ db: reopened.db, logger });
    const marked = await afterRestart.migrateLegacyJobs();

    expect(marked).toBe(2);
    expect(await afterRestart.pending()).toHaveLength(0);

    // The second start does nothing: the mark is written.
    expect(await afterRestart.migrateLegacyJobs()).toBe(0);
    reopened.client.close();
  });

  it("continues the jobs that this version queued after a restart", async () => {
    const { file, client, inbox } = await makeInbox();
    await inbox.migrateLegacyJobs();
    await inbox.accept({ updateId: "2001", payload: "a new thought" });
    client.close();

    // A restart of the same version: the queued job is picked up again.
    const reopened = await createDatabase(file);
    const afterRestart = new Inbox({ db: reopened.db, logger });
    await afterRestart.migrateLegacyJobs();
    const pending = await afterRestart.pending();

    expect(pending.map((row) => row.updateId)).toEqual(["2001"]);
    reopened.client.close();
  });

  it("keeps the payload of an interrupted job", async () => {
    const { client, inbox } = await makeInbox();
    await inbox.accept({ updateId: "3001", payload: "the text of the owner" });
    await inbox.migrateLegacyJobs();

    const rows = await client.execute("SELECT payload, state FROM jobs WHERE update_id = '3001'");
    expect(rows.rows[0]?.payload).toBe("the text of the owner");
    expect(rows.rows[0]?.state).toBe("interrupted");
    client.close();
  });
});
