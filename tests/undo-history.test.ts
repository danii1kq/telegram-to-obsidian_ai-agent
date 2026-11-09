import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { undoLast } from "../src/bot/actions.js";
import { createDatabase } from "../src/db/index.js";
import { undoLog } from "../src/db/schema.js";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

async function makeWorld() {
  const root = await mkdtemp(path.join(tmpdir(), "undo2-"));
  const vaultPath = path.join(root, "vault");
  const guard = new VaultGuard({
    vaultRoot: vaultPath,
    settleDelayMs: 1,
    verifyDelayMs: 1,
    retryDelayMs: 1,
  });
  const vault = new VaultOperations({
    guard,
    eventsFile: path.join(root, "events.json"),
    timeZone: "Asia/Almaty",
    logger,
  });
  const { client, db } = await createDatabase(path.join(root, "app.db"));
  return { root, vaultPath, vault, db, client };
}

describe("A08: the undo of an overwrite", () => {
  it("restores the text that was there before the overwrite", async () => {
    const { vaultPath, vault, db, client } = await makeWorld();

    await vault.writeNote("Diary.md", "the original text");
    // The bot rewrites the whole note, which is what an overwrite is.
    await vault.writeNote("Diary.md", "the text of the bot");

    const before = await readFile(path.join(vaultPath, "Diary.md"), "utf8");
    expect(before).toContain("the text of the bot");

    await db.insert(undoLog).values({
      createdAt: new Date().toISOString(),
      action: "overwrite",
      path: "Diary.md",
      title: "Diary",
      previous: "the original text",
      telegramUserId: "1",
    });

    const result = await undoLast({ vault, db, logger }, 1, "ru");
    expect(result).toContain("Вернул");

    const after = await readFile(path.join(vaultPath, "Diary.md"), "utf8");
    expect(after).toContain("the original text");
    client.close();
  });

  it("does not delete a note the owner changed after the bot created it", async () => {
    const { root, vaultPath, vault, db, client } = await makeWorld();

    await vault.writeNote("Ideas.md", "an idea");
    await db.insert(undoLog).values({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      action: "create",
      path: "Ideas.md",
      title: "Ideas",
      telegramUserId: "1",
    });

    // The owner edits the note a moment after the bot wrote it. The old check
    // allowed five seconds of tolerance, and an edit inside that window was
    // deleted without a question.
    await writeFile(
      path.join(root, "vault", "Ideas.md"),
      "an idea, and a line of the owner",
      "utf8",
    );

    const answer = await undoLast({ vault, db, logger }, 1, "ru");
    expect(answer).toContain("Ответь /undo confirm");

    // The note is still there: the question was asked, not answered.
    const content = await readFile(path.join(vaultPath, "Ideas.md"), "utf8");
    expect(content).toContain("a line of the owner");
    client.close();
  });

  it("asks before deleting a note the owner changed inside the old five second window", async () => {
    const { root, vaultPath, vault, db, client } = await makeWorld();

    await vault.writeNote("Ideas.md", "an idea");
    // The entry is written a moment ago, which is the case the old check let
    // through: the tolerance was five seconds, so an edit inside it was not
    // seen and the note was deleted without a question.
    await db.insert(undoLog).values({
      createdAt: new Date(Date.now() - 1000).toISOString(),
      action: "create",
      path: "Ideas.md",
      title: "Ideas",
      telegramUserId: "1",
    });

    await writeFile(
      path.join(root, "vault", "Ideas.md"),
      "an idea, and a line of the owner",
      "utf8",
    );

    const answer = await undoLast({ vault, db, logger }, 1, "ru");
    expect(answer).toContain("Ответь /undo confirm");

    // The note is still there, with the line of the owner.
    const content = await readFile(path.join(vaultPath, "Ideas.md"), "utf8");
    expect(content).toContain("a line of the owner");
    client.close();
  });

  it("binds the confirmation to the exact operation", async () => {
    const { root, vaultPath, vault, db, client } = await makeWorld();

    await vault.writeNote("Ideas.md", "an idea");
    await db.insert(undoLog).values({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      action: "create",
      path: "Ideas.md",
      title: "Ideas",
      telegramUserId: "1",
    });
    await writeFile(path.join(root, "vault", "Ideas.md"), "edited by the owner", "utf8");

    // The question is asked for this entry.
    const question = await undoLast({ vault, db, logger }, 1, "ru");
    expect(question).toContain("Ответь /undo confirm");

    // A new write of the bot arrives before the owner confirms. The
    // confirmation belongs to the old entry, not to the new one.
    await vault.writeNote("Other.md", "another note");
    await db.insert(undoLog).values({
      createdAt: new Date().toISOString(),
      action: "create",
      path: "Other.md",
      title: "Other",
      telegramUserId: "1",
    });

    // The confirmation is for the old entry, so the new note is not deleted.
    const confirmed = await undoLast({ vault, db, logger }, 1, "ru", true);
    expect(confirmed).not.toContain("Other");

    const other = await readFile(path.join(vaultPath, "Other.md"), "utf8");
    expect(other).toContain("another note");
    client.close();
  });

  it("does not undo a note that the owner changed after the bot appended", async () => {
    const { vaultPath, vault, db, client } = await makeWorld();

    await vault.writeNote("Diary.md", "the first line");
    await vault.appendNote("Diary.md", "the block of the bot");

    await db.insert(undoLog).values({
      createdAt: new Date().toISOString(),
      action: "append",
      path: "Diary.md",
      title: "Diary",
      block: "the block of the bot",
      telegramUserId: "1",
    });

    // The owner adds a line after the block of the bot.
    const current = await readFile(path.join(vaultPath, "Diary.md"), "utf8");
    await writeFile(
      path.join(vaultPath, "Diary.md"),
      `${current}\nthe line of the owner\n`,
      "utf8",
    );

    const result = await undoLast({ vault, db, logger }, 1, "ru");
    // The block of the bot is gone, the line of the owner stays.
    const after = await readFile(path.join(vaultPath, "Diary.md"), "utf8");
    expect(after).toContain("the line of the owner");
    expect(after).not.toContain("the block of the bot");
    expect(result).toBeTruthy();
    client.close();
  });
});
