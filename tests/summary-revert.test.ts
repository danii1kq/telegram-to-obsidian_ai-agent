import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDailySummary } from "../src/daily/summary.js";
import { localDayStartMs } from "../src/daily/time.js";
import { createDatabase } from "../src/db/index.js";
import { notesLog } from "../src/db/schema.js";
import type { HermesClient } from "../src/hermes/client.js";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

/**
 * The config of the summary.
 *
 * `eventsFile` has to point at the log of the test, otherwise the revert reads
 * nothing and a test of the revert proves nothing.
 */
function makeConfig(eventsFile: string) {
  return {
    vault: { path: "/vault", timeZone: "Asia/Almaty", eventsFile },
  } as unknown as Parameters<typeof runDailySummary>[0]["config"];
}

/** An agent that only answers with a text and writes nothing. */
function quietAgent(): HermesClient {
  return {
    run: async () => ({
      ok: true,
      text: "День был спокойным.",
      durationMs: 5,
      model: "test",
      usedFallback: false,
      stderr: "",
    }),
  } as unknown as HermesClient;
}

async function makeWorld() {
  const root = await mkdtemp(path.join(tmpdir(), "summary-"));
  const vaultPath = path.join(root, "vault");
  const guard = new VaultGuard({ vaultRoot: vaultPath, settleDelayMs: 1, verifyDelayMs: 1 });
  const vault = new VaultOperations({
    guard,
    eventsFile: path.join(root, "events.json"),
    timeZone: "Asia/Almaty",
    logger,
  });
  const { client, db } = await createDatabase(path.join(root, "app.db"));
  return { root, vaultPath, vault, db, client };
}

describe("A03: the summary never takes back the notes of another job", () => {
  it("keeps a note of the previous job when the agent writes nothing", async () => {
    const { root, vaultPath, vault, db, client } = await makeWorld();

    // The previous job wrote a legitimate note a moment ago. It is inside the
    // window the old revert used to look at, and it belongs to nobody else.
    await vault.writeNote("Previous job.md", "a thought of the owner from the last message");

    await db.insert(notesLog).values({
      createdAt: new Date(localDayStartMs("2026-10-21", "Asia/Almaty") + 3600_000).toISOString(),
      action: "create",
      path: "Previous job.md",
      title: "Previous job",
      source: "agent",
      bytes: 10,
      telegramUserId: "1",
    });

    const summary = await runDailySummary(
      {
        config: makeConfig(path.join(root, "events.json")),
        db,
        vault,
        hermes: quietAgent(),
        logger,
      },
      "2026-10-21",
    );
    expect(summary?.day).toBe("2026-10-21");

    // The note of the previous job is still there, untouched.
    const kept = await readFile(path.join(vaultPath, "Previous job.md"), "utf8");
    expect(kept).toContain("a thought of the owner from the last message");

    client.close();
  });

  it("keeps a note the owner edited by hand while the summary ran", async () => {
    const { root, vaultPath, vault, db, client } = await makeWorld();

    await vault.writeNote("Diary.md", "the first line");
    await db.insert(notesLog).values({
      createdAt: new Date(localDayStartMs("2026-10-21", "Asia/Almaty") + 3600_000).toISOString(),
      action: "create",
      path: "Diary.md",
      title: "Diary",
      source: "agent",
      bytes: 10,
      telegramUserId: "1",
    });

    // The owner edits the note in Obsidian at the same time as the summary.
    await vault.appendNote("Diary.md", "a line the owner added by hand");

    const summary = await runDailySummary(
      {
        config: makeConfig(path.join(root, "events.json")),
        db,
        vault,
        hermes: quietAgent(),
        logger,
      },
      "2026-10-21",
    );
    expect(summary).not.toBeNull();

    const content = await readFile(path.join(vaultPath, "Diary.md"), "utf8");
    expect(content).toContain("the first line");
    expect(content).toContain("a line the owner added by hand");

    client.close();
  });

  it("does not delete a note that appeared next to the summary", async () => {
    const { root, vaultPath, vault, db, client } = await makeWorld();

    await vault.writeNote("Ideas.md", "an idea for the business");
    await db.insert(notesLog).values({
      createdAt: new Date(
        localDayStartMs("2026-10-21", "/Almaty".replace("/", "Asia/")) + 3600_000,
      ).toISOString(),
      action: "create",
      path: "Ideas.md",
      title: "Ideas",
      source: "agent",
      bytes: 10,
      telegramUserId: "1",
    });

    // A note written by the fallback writer of another message, right before
    // the summary starts. It is not a stray write of the summary agent.
    await vault.writeNote("Another message.md", "written by the bot, not by the summary");

    await runDailySummary(
      {
        config: makeConfig(path.join(root, "events.json")),
        db,
        vault,
        hermes: quietAgent(),
        logger,
      },
      "2026-10-21",
    );

    const kept = await readFile(path.join(vaultPath, "Another message.md"), "utf8");
    expect(kept).toContain("written by the bot, not by the summary");

    client.close();
  });
});
