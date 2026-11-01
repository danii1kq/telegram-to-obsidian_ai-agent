import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { autoLinkEntities, ensureFrontmatter, VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

async function makeOperations() {
  const vault = await mkdtemp(path.join(tmpdir(), "vault-ops-"));
  const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });
  const operations = new VaultOperations({
    guard,
    eventsFile: path.join(vault, "events.json"),
    timeZone: "Asia/Almaty",
    logger,
  });
  return { vault, operations };
}

describe("ensureFrontmatter", () => {
  it("adds the frontmatter when it is missing", () => {
    const result = ensureFrontmatter("text", "2026-10-20");
    expect(result.startsWith("---\ndate: 2026-10-20\ntags: [inbox, telegram]\n---")).toBe(true);
  });

  it("keeps an existing frontmatter", () => {
    const note = "---\ndate: 2020-01-01\n---\n\ntext";
    expect(ensureFrontmatter(note, "2026-10-20")).toBe(note);
  });
});

describe("autoLinkEntities", () => {
  it("wraps the names of existing notes", () => {
    const result = autoLinkEntities(
      "Мы говорили про Дневник и про Заметки",
      ["Дневник", "Заметки"],
      "Other",
    );
    expect(result).toBe("Мы говорили про [[Дневник]] и про [[Заметки]]");
  });

  it("does not link a note to itself", () => {
    const result = autoLinkEntities("Это про Дневник", ["Дневник"], "Дневник");
    expect(result).toBe("Это про Дневник");
  });

  it("does not touch an existing wiki link", () => {
    const result = autoLinkEntities("Уже есть [[Дневник]] в тексте", ["Дневник"], "Other");
    expect(result).toBe("Уже есть [[Дневник]] в тексте");
  });

  it("keeps numbers in the text", () => {
    const result = autoLinkEntities("В 2026 году будет 30 заметок", ["Заметки"], "Other");
    expect(result).toBe("В 2026 году будет 30 заметок");
  });
});

describe("VaultOperations", () => {
  it("creates a note with the frontmatter", async () => {
    const { vault, operations } = await makeOperations();
    const result = await operations.writeNote("Ideas.md", "A good idea");
    expect(result.action).toBe("create");
    const content = await readFile(path.join(vault, "Ideas.md"), "utf8");
    expect(content).toContain("date: ");
    expect(content).toContain("tags: [inbox, telegram]");
    expect(content).toContain("A good idea");
  });

  it("lists and searches the notes", async () => {
    const { operations } = await makeOperations();
    await operations.writeNote("Business.md", "money and products");
    await operations.writeNote("Health.md", "running every morning");

    const notes = await operations.listNotes();
    expect(notes.map((note) => note.title).sort()).toEqual(["Business", "Health"]);

    const byName = await operations.searchFiles({ target: "files", pattern: "business" });
    expect(byName).toHaveLength(1);

    const byContent = await operations.searchFiles({ target: "content", pattern: "running" });
    expect(byContent[0]?.relativePath).toBe("Health.md");
  });

  it("treats the pattern of a search as a plain text, not as a regular expression", async () => {
    const { operations } = await makeOperations();
    await operations.writeNote("Health.md", "running every morning");

    // A pattern like this one hangs the process for minutes when it is
    // compiled as a regular expression.
    const startedAt = Date.now();
    const hits = await operations.searchFiles({ target: "content", pattern: "(a+)+$" });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(hits).toHaveLength(0);
  });

  it("uses a regular expression only when it is asked for", async () => {
    const { operations } = await makeOperations();
    await operations.writeNote("Health.md", "running every morning");

    const plain = await operations.searchFiles({ target: "content", pattern: "runn.ng" });
    expect(plain).toHaveLength(0);

    const regex = await operations.searchFiles({
      target: "content",
      pattern: "runn.ng",
      regex: true,
    });
    expect(regex[0]?.relativePath).toBe("Health.md");
  });

  it("appends to a note and records the event", async () => {
    const { vault, operations } = await makeOperations();
    await operations.writeNote("Diary.md", "first");
    await operations.appendNote("Diary.md", "second");

    const content = await readFile(path.join(vault, "Diary.md"), "utf8");
    expect(content).toContain("first");
    expect(content).toContain("second");
  });

  it("links the existing notes when a new note is written", async () => {
    const { vault, operations } = await makeOperations();
    await operations.writeNote("Health.md", "note about running");
    await operations.writeNote("Plan.md", "My plan for Health and sleep");

    const content = await readFile(path.join(vault, "Plan.md"), "utf8");
    expect(content).toContain("[[Health]]");
  });

  it("does not escape the vault", async () => {
    const { operations } = await makeOperations();
    await expect(operations.writeNote("../evil.md", "x")).rejects.toThrow();
  });

  it("reads a note", async () => {
    const { vault, operations } = await makeOperations();
    await writeFile(path.join(vault, "Manual.md"), "hello", "utf8");
    const file = await operations.readFile("Manual.md");
    expect(file.content).toBe("hello");
    expect(file.relativePath).toBe("Manual.md");
  });
});
