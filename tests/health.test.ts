import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/index.js";
import { healthReport } from "../src/health.js";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

async function makeWorld() {
  const root = await mkdtemp(path.join(tmpdir(), "health-"));
  const vaultPath = path.join(root, "vault");
  // The vault folder exists in a real deployment: the bot creates it at start.
  await mkdir(vaultPath, { recursive: true });
  const guard = new VaultGuard({ vaultRoot: vaultPath, settleDelayMs: 1, verifyDelayMs: 1 });
  const vault = new VaultOperations({
    guard,
    eventsFile: path.join(root, "events.json"),
    timeZone: "Asia/Almaty",
    logger,
  });
  const { client, db } = await createDatabase(path.join(root, "app.db"));
  return { vault, db, client };
}

describe("the health of the process", () => {
  it("is ok when the database and the vault answer", async () => {
    const { vault, db, client } = await makeWorld();
    const report = await healthReport({
      db,
      vault,
      logger,
      queueSize: () => 0,
      lastMessageAt: () => null,
      startedAt: Date.now() - 60_000,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.database.ok).toBe(true);
    expect(report.checks.vault.ok).toBe(true);
    expect(report.checks.queue.ok).toBe(true);
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(59);
    client.close();
  });

  it("is not ok when the database does not answer", async () => {
    const { vault, db, client } = await makeWorld();
    // A closed client is a database that cannot answer any more.
    client.close();

    const report = await healthReport({
      db,
      vault,
      logger,
      queueSize: () => 0,
      lastMessageAt: () => null,
      startedAt: Date.now(),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.database.ok).toBe(false);
    expect(report.checks.database.detail).toBeTruthy();
  });

  it("is not ok when the vault is gone", async () => {
    const { vault, db, client } = await makeWorld();
    // A vault that was removed or unmounted is not an empty vault.
    await rm(vault.vaultRoot, { recursive: true, force: true });

    const report = await healthReport({
      db,
      vault,
      logger,
      queueSize: () => 0,
      lastMessageAt: () => null,
      startedAt: Date.now(),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.vault.ok).toBe(false);
    expect(report.checks.database.ok).toBe(true);
    client.close();
  });

  it("is not ok when the queue is backing up", async () => {
    const { vault, db, client } = await makeWorld();
    const report = await healthReport({
      db,
      vault,
      logger,
      queueSize: () => 500,
      lastMessageAt: () => null,
      startedAt: Date.now(),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.queue.ok).toBe(false);
    expect(report.checks.queue.detail).toContain("500");
    client.close();
  });
});
