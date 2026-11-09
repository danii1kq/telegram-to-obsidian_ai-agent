import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  cleanSummary,
  revertStrayWrites,
  runDailySummary,
  summaryNotice,
  writeSection,
} from "../src/daily/summary.js";
import {
  localDate,
  localDayStartMs,
  monthFileName,
  monthTitle,
  nextLocalMidnightMs,
  previousDay,
} from "../src/daily/time.js";
import { createDatabase } from "../src/db/index.js";
import { notesLog } from "../src/db/schema.js";
import type { HermesClient } from "../src/hermes/client.js";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

const config = {
  vault: { path: "/vault", timeZone: "Asia/Almaty" },
} as unknown as Parameters<typeof runDailySummary>[0]["config"];

const hermes = {
  run: async () => ({
    ok: true,
    text: "День был продуктивным: дописал заметку о проекте и придумал новую идею.",
    durationMs: 10,
    model: "test",
    usedFallback: false,
    stderr: "",
  }),
} as unknown as HermesClient;

async function makeWorld() {
  const root = await mkdtemp(path.join(tmpdir(), "daily-"));
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

describe("the time of the vault", () => {
  it("names the file of a month", () => {
    expect(monthFileName("2026-10-21")).toBe("october_2026.md");
    expect(monthFileName("2026-01-05")).toBe("january_2026.md");
  });

  it("names the title of a month", () => {
    expect(monthTitle("2026-10-21")).toBe("Октябрь 2026");
    expect(monthTitle("2026-10-21", "en")).toBe("October 2026");
  });

  it("knows the day before", () => {
    expect(previousDay("2026-10-21")).toBe("2026-10-20");
    expect(previousDay("2026-10-01")).toBe("2026-09-30");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
  });

  it("knows the date of a moment in the time zone", () => {
    // 21:30 UTC is already the next day in Almaty.
    expect(localDate(new Date("2026-10-21T21:30:00Z"), "Asia/Almaty")).toBe("2026-10-22");
    expect(localDate(new Date("2026-10-21T12:00:00Z"), "Asia/Almaty")).toBe("2026-10-21");
  });

  it("knows when a local day begins", () => {
    // Almaty is UTC+5, so the day begins at 19:00 UTC of the day before.
    expect(new Date(localDayStartMs("2026-10-21", "Asia/Almaty")).toISOString()).toBe(
      "2026-10-20T19:00:00.000Z",
    );
  });

  it("knows when the next midnight comes", () => {
    const next = nextLocalMidnightMs(new Date("2026-10-21T12:00:00Z"), "Asia/Almaty");
    expect(new Date(next).toISOString()).toBe("2026-10-21T19:00:00.000Z");
  });
});

describe("buildSummaryPrompt", () => {
  it("carries the notes of the day", () => {
    const prompt = buildSummaryPrompt("2026-10-21", [
      { title: "Ideas", path: "Ideas.md", action: "create", excerpt: "a good idea" },
    ]);
    expect(prompt).toContain("2026-10-21");
    expect(prompt).toContain("Ideas.md");
    expect(prompt).toContain("a good idea");
  });
});

describe("cleanSummary", () => {
  it("takes the text of the agent", () => {
    expect(cleanSummary("Вывод: день был хороший.")).toBe("день был хороший.");
  });

  it("never keeps a long dash", () => {
    expect(cleanSummary("день — хороший")).toBe("день - хороший");
  });

  it("takes off the quotes", () => {
    expect(cleanSummary('"день хороший"')).toBe("день хороший");
  });
});

describe("writeSection", () => {
  it("creates the file of the month", async () => {
    const { vaultPath, vault } = await makeWorld();
    const file = await writeSection(vault, "2026-10-21", "Первый день.");
    expect(file).toBe("october_2026.md");

    const content = await readFile(path.join(vaultPath, "october_2026.md"), "utf8");
    expect(content).toContain("# Октябрь 2026");
    expect(content).toContain("## 2026-10-21");
    expect(content).toContain("Первый день.");
  });

  it("writes the title in the language of the owner", async () => {
    const { vaultPath, vault } = await makeWorld();
    await writeSection(vault, "2026-10-21", "The first day.", "en");

    const content = await readFile(path.join(vaultPath, "october_2026.md"), "utf8");
    expect(content).toContain("# October 2026");
    expect(content).toContain("The first day.");
  });

  it("adds the next day to the same file", async () => {
    const { vaultPath, vault } = await makeWorld();
    await writeSection(vault, "2026-10-21", "Первый день.");
    await writeSection(vault, "2026-10-22", "Второй день.");

    const content = await readFile(path.join(vaultPath, "october_2026.md"), "utf8");
    expect(content.indexOf("## 2026-10-21")).toBeLessThan(content.indexOf("## 2026-10-22"));
  });
});

describe("summaryNotice", () => {
  it("says that the summary is ready", () => {
    const notice = summaryNotice("2026-10-21");
    expect(notice.text).toContain("2026-10-21");
    expect(notice.text).toContain("мини-приложении");
    expect(notice.miniAppUrl).toBeUndefined();
  });

  it("carries the address of the mini app", () => {
    const notice = summaryNotice("2026-10-21", "https://notes.example.com");
    expect(notice.miniAppUrl).toBe("https://notes.example.com");
  });
});

describe("revertStrayWrites", () => {
  it("takes back only the writes of the run it is given", async () => {
    const { root, vaultPath, vault } = await makeWorld();
    const eventsFile = path.join(root, "events.json");

    await vault.writeNote("Идеи.md", "мысль");
    // The agent writes a note while it should only answer with a text. The
    // write carries the run id, so it can be told apart from the others.
    await vault.writeNote("Дневник.md", "вывод агента", { runId: "run-1" });

    const reverted = await revertStrayWrites(vault, eventsFile, "run-1");
    expect(reverted).toBe(1);

    await expect(readFile(path.join(vaultPath, "Дневник.md"), "utf8")).rejects.toThrow();
    const kept = await readFile(path.join(vaultPath, "Идеи.md"), "utf8");
    expect(kept).toContain("мысль");
  });

  it("never takes back a write of another run, however close in time", async () => {
    const { root, vaultPath, vault } = await makeWorld();
    const eventsFile = path.join(root, "events.json");

    // Two jobs, one right after the other: the second one is a legitimate
    // note of the owner, and it is a millisecond away from the first.
    await vault.writeNote("Первый.md", "первая заметка", { runId: "run-1" });
    await vault.writeNote("Второй.md", "вторая заметка", { runId: "run-2" });

    const reverted = await revertStrayWrites(vault, eventsFile, "run-1");
    expect(reverted).toBe(1);

    await expect(readFile(path.join(vaultPath, "Первый.md"), "utf8")).rejects.toThrow();
    const kept = await readFile(path.join(vaultPath, "Второй.md"), "utf8");
    expect(kept).toContain("вторая заметка");
  });

  it("does nothing when it is given no run id", async () => {
    const { root, vaultPath, vault } = await makeWorld();
    const eventsFile = path.join(root, "events.json");

    await vault.writeNote("Заметка.md", "текст", { runId: "run-1" });

    const reverted = await revertStrayWrites(vault, eventsFile, "");
    expect(reverted).toBe(0);
    const kept = await readFile(path.join(vaultPath, "Заметка.md"), "utf8");
    expect(kept).toContain("текст");
  });
});

describe("runDailySummary", () => {
  it("writes the summary of a day with notes", async () => {
    const { vaultPath, vault, db, client } = await makeWorld();
    await vault.writeNote("Ideas.md", "an idea for the business");
    await db.insert(notesLog).values({
      createdAt: new Date(localDayStartMs("2026-10-21", "Asia/Almaty") + 3600_000).toISOString(),
      action: "create",
      path: "Ideas.md",
      title: "Ideas",
      source: "agent",
      bytes: 10,
      telegramUserId: "1",
    });

    const summary = await runDailySummary({ config, db, vault, hermes, logger }, "2026-10-21");
    expect(summary?.day).toBe("2026-10-21");
    expect(summary?.file).toBe("october_2026.md");

    const content = await readFile(path.join(vaultPath, "october_2026.md"), "utf8");
    expect(content).toContain("## 2026-10-21");
    client.close();
  });

  it("writes nothing when the day was empty", async () => {
    const { vaultPath, vault, db, client } = await makeWorld();
    const summary = await runDailySummary({ config, db, vault, hermes, logger }, "2026-10-21");
    expect(summary).toBeNull();

    await expect(readFile(path.join(vaultPath, "october_2026.md"), "utf8")).rejects.toThrow();
    client.close();
  });
});
