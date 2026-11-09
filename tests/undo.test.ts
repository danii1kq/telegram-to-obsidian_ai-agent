import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashOf, listInbox, searchNotes, undoLast } from "../src/bot/actions.js";
import { createDatabase } from "../src/db/index.js";
import { undoLog } from "../src/db/schema.js";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

async function makeWorld() {
  const root = await mkdtemp(path.join(tmpdir(), "undo-"));
  const vaultPath = path.join(root, "vault");
  const guard = new VaultGuard({
    vaultRoot: vaultPath,
    settleDelayMs: 1,
    verifyDelayMs: 1,
  });
  const vault = new VaultOperations({
    guard,
    eventsFile: path.join(root, "events.json"),
    timeZone: "Asia/Almaty",
    logger,
  });
  const { client, db } = await createDatabase(path.join(root, "app.db"));
  return { root, vault, db, client };
}

describe("searchNotes", () => {
  it("finds a note by its name and by its text", async () => {
    const { vault, db, client } = await makeWorld();
    await vault.writeNote("Health.md", "running every morning");
    await vault.writeNote("Business.md", "coffee and products");

    const deps = { vault, db, logger };
    const byName = await searchNotes("health", deps, "ru");
    expect(byName).toContain("Health.md");

    const byText = await searchNotes("running", deps, "ru");
    expect(byText).toContain("Health.md");

    client.close();
  });

  it("says that nothing was found", async () => {
    const { vault, db, client } = await makeWorld();
    const result = await searchNotes("nothing here", { vault, db, logger }, "ru");
    expect(result).toContain("Ничего не нашлось");
    client.close();
  });
});

describe("listInbox", () => {
  it("lists the notes of the inbox", async () => {
    const { vault, db, client } = await makeWorld();
    await vault.writeNote("Ideas.md", "an idea");
    await vault.writeNote("Health.md", "running");

    const result = await listInbox({ vault, db, logger }, "ru");
    expect(result).toContain("Ideas.md");
    expect(result).toContain("Health.md");
    client.close();
  });
});

describe("undoLast", () => {
  it("removes the appended block", async () => {
    const { root, vault, db, client } = await makeWorld();
    await vault.writeNote("Diary.md", "first");
    await vault.appendNote("Diary.md", "second");

    const event = (await vault.searchFiles({ target: "files", pattern: "Diary" }))[0];
    expect(event?.relativePath).toBe("Diary.md");

    await db.insert(undoLog).values({
      createdAt: new Date().toISOString(),
      action: "append",
      path: "Diary.md",
      title: "Diary",
      block: "second",
      telegramUserId: "1",
    });

    const result = await undoLast({ vault, db, logger }, 1, "ru");
    expect(result).toContain("Убрал свою запись");

    const content = await readFile(path.join(root, "vault", "Diary.md"), "utf8");
    expect(content).toContain("first");
    expect(content).not.toContain("second");
    client.close();
  });

  it("deletes a note that the bot created", async () => {
    const { root, vault, db, client } = await makeWorld();
    await vault.writeNote("Ideas.md", "an idea");

    // The entry carries the hash of the text the bot wrote, which is how the
    // undo proves the note is still the bot's before deleting it.
    const written = await readFile(path.join(root, "vault", "Ideas.md"), "utf8");
    await db.insert(undoLog).values({
      createdAt: new Date().toISOString(),
      action: "create",
      path: "Ideas.md",
      title: "Ideas",
      contentHash: hashOf(written),
      telegramUserId: "1",
    });

    const result = await undoLast({ vault, db, logger }, 1, "ru");
    expect(result).toContain("Удалил заметку");

    await expect(readFile(path.join(root, "vault", "Ideas.md"), "utf8")).rejects.toThrow();
    client.close();
  });

  it("asks for a confirmation when the note was changed after the write", async () => {
    const { root, vault, db, client } = await makeWorld();
    await vault.writeNote("Ideas.md", "an idea");

    await db.insert(undoLog).values({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      action: "create",
      path: "Ideas.md",
      title: "Ideas",
      telegramUserId: "1",
    });

    // Somebody edited the note after the bot created it.
    await writeFile(path.join(root, "vault", "Ideas.md"), "an idea, edited by hand", "utf8");

    const question = await undoLast({ vault, db, logger }, 1, "ru");
    expect(question).toContain("Ответь /undo confirm");

    const confirmed = await undoLast({ vault, db, logger }, 1, "ru", true);
    expect(confirmed).toContain("Удалил заметку");
    client.close();
  });

  it("says that there is nothing to undo", async () => {
    const { vault, db, client } = await makeWorld();
    const result = await undoLast({ vault, db, logger }, 1, "ru");
    expect(result).toContain("Отменять нечего");
    client.close();
  });
});
