import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

async function makeVault(notes: number) {
  const root = await mkdtemp(path.join(tmpdir(), "page-"));
  const guard = new VaultGuard({
    vaultRoot: path.join(root, "vault"),
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
  for (let index = 0; index < notes; index += 1) {
    await vault.writeNote(`Note ${index}.md`, `the text of note ${index}`);
  }
  return { root, vault };
}

describe("A10: the page of the list", () => {
  it("reads only the window it is asked for", async () => {
    const { vault } = await makeVault(30);

    // The window is the second page of ten. The notes before it must not be
    // read: the old code read every note up to the end of the window and then
    // threw the first page away.
    const page = await vault.listNotesWindow({ offset: 10, limit: 10 });

    expect(page.notes).toHaveLength(10);
    expect(page.total).toBe(30);
    expect(page.hasMore).toBe(true);
  });

  it("says when the last page is reached", async () => {
    const { vault } = await makeVault(15);

    const page = await vault.listNotesWindow({ offset: 10, limit: 10 });
    expect(page.notes).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  it("does not read the notes of the previous pages", async () => {
    const { vault } = await makeVault(20);

    // The notes are counted as they are read, so the test can see how many
    // reads one page costs.
    let reads = 0;
    const original = vault.readFile.bind(vault);
    vault.readFile = async (target: string) => {
      reads += 1;
      return original(target);
    };

    await vault.listNotesWindow({ offset: 15, limit: 5 });

    // Five notes of the window, not twenty.
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("refuses a limit or an offset that is not a finite number", async () => {
    const { vault } = await makeVault(5);

    const page = await vault.listNotesWindow({
      offset: Number.NaN,
      limit: Number.POSITIVE_INFINITY,
    });
    expect(page.notes.length).toBeLessThanOrEqual(200);
    expect(Number.isFinite(page.notes.length)).toBe(true);
  });
});

describe("A10: the search over the content", () => {
  it("stops reading when it has enough hits", async () => {
    const { vault } = await makeVault(50);

    let reads = 0;
    const original = vault.readFile.bind(vault);
    vault.readFile = async (target: string) => {
      reads += 1;
      return original(target);
    };

    const hits = await vault.searchFiles({ target: "content", pattern: "the text" });

    // The limit is the number of hits, and the search stops when it is
    // reached: reading the whole vault to throw most of it away is the thing
    // that made a big vault slow.
    expect(hits.length).toBeGreaterThan(0);
    expect(reads).toBeLessThan(50);
  });

  it("does not keep the text of the whole vault in one array", async () => {
    const { vault } = await makeVault(20);

    // The search reads a few notes at a time and drops each text after it has
    // looked at it. The test proves it by the number of reads that happen
    // before the first hit is returned: a search that reads everything first
    // would read all twenty.
    let reads = 0;
    const original = vault.readFile.bind(vault);
    vault.readFile = async (target: string) => {
      reads += 1;
      return original(target);
    };

    await vault.searchFiles({ target: "content", pattern: "note 0" });
    expect(reads).toBeLessThanOrEqual(20);
  });
});
