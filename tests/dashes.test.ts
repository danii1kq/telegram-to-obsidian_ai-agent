import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { normalizeDashes, VaultOperations } from "../src/vault/operations.js";
import { sanitizeFileName } from "../src/vault/paths.js";

const logger = createLogger("error", "test");

describe("normalizeDashes", () => {
  it("replaces the long dashes with a simple hyphen", () => {
    expect(normalizeDashes("слово — слово")).toBe("слово - слово");
    expect(normalizeDashes("слово – слово")).toBe("слово - слово");
    expect(normalizeDashes("слово ‒ слово")).toBe("слово - слово");
    expect(normalizeDashes("слово ― слово")).toBe("слово - слово");
  });

  it("keeps the simple hyphen", () => {
    expect(normalizeDashes("слово - слово")).toBe("слово - слово");
  });
});

describe("the file name of a note", () => {
  it("has no long dash", () => {
    expect(sanitizeFileName("Идея — бизнес")).toBe("Идея - бизнес");
  });
});

describe("the notes of the agent", () => {
  it("are written without the long dashes", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "vault-dashes-"));
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });
    const operations = new VaultOperations({
      guard,
      eventsFile: path.join(vault, "events.json"),
      timeZone: "Asia/Almaty",
      logger,
    });

    await operations.writeNote("Ideas.md", "Первая мысль — и вторая");
    await operations.appendNote("Ideas.md", "Ещё мысль — продолжение");

    const content = await readFile(path.join(vault, "Ideas.md"), "utf8");
    expect(content).toContain("Первая мысль - и вторая");
    expect(content).toContain("Ещё мысль - продолжение");
    expect(content).not.toMatch(/[—–‒―]/);
  });
});
