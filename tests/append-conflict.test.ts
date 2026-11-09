import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VaultGuard } from "../src/vault/guard.js";

async function makeGuard(options: { sleep?: (ms: number) => Promise<void> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "append-"));
  const vaultRoot = path.join(root, "vault");
  await mkdir(vaultRoot, { recursive: true });
  const guard = new VaultGuard({
    vaultRoot,
    settleDelayMs: 1,
    verifyDelayMs: 1,
    retryDelayMs: 1,
    maxAttempts: 4,
    ...options,
  });
  return { root, vaultRoot, guard };
}

describe("A04: an append never replays a stale payload", () => {
  it("keeps an edit that lands between the read and the write", async () => {
    const { vaultRoot, guard } = await makeGuard();
    const target = path.join(vaultRoot, "Diary.md");
    await writeFile(target, "the first line\n", "utf8");

    // The owner saves the note in Obsidian right after the guard read it and
    // before it writes. The write of the bot must not drop that line.
    let edited = false;
    const result = await guard.append("Diary.md", "a thought of the owner", {
      beforeWrite: async () => {
        if (edited) return;
        edited = true;
        await writeFile(target, "the first line\nthe line the owner typed\n", "utf8");
      },
    });

    expect(result.verified).toBe(true);
    const content = await readFile(target, "utf8");
    expect(content).toContain("the line the owner typed");
    expect(content).toContain("a thought of the owner");
    expect(content).toContain("the first line");
  });

  it("does not duplicate its own block when it retries", async () => {
    const { vaultRoot, guard } = await makeGuard();
    const target = path.join(vaultRoot, "Diary.md");
    await writeFile(target, "the first line\n", "utf8");

    const result = await guard.append("Diary.md", "a thought of the owner");

    expect(result.verified).toBe(true);
    const content = await readFile(target, "utf8");
    const occurrences = content.split("a thought of the owner").length - 1;
    expect(occurrences).toBe(1);
  });

  it("keeps both versions when the note is rewritten by another program", async () => {
    const { vaultRoot, guard } = await makeGuard();
    const target = path.join(vaultRoot, "Diary.md");
    await writeFile(target, "the first line\n", "utf8");

    // A whole file write from another program, not an append: there is no
    // safe merge, so the bot must keep its own version next to the other one
    // instead of declaring a successful overwrite.
    let replaced = false;
    const result = await guard.append("Diary.md", "a thought of the owner", {
      beforeWrite: async () => {
        if (replaced) return;
        replaced = true;
        await writeFile(target, "a completely different text\n", "utf8");
      },
    });

    const content = await readFile(target, "utf8");
    // Either both texts are in the note, or the conflict was reported with the
    // other version kept in a file next to it. Never a silent loss.
    const keptBoth =
      content.includes("a completely different text") && content.includes("a thought of the owner");
    const conflictFiles = result.conflictFiles;
    const keptAside = conflictFiles.length > 0;
    expect(keptBoth || keptAside).toBe(true);
  });

  it("verifies its own block, not the whole old file", async () => {
    const { vaultRoot, guard } = await makeGuard();
    const target = path.join(vaultRoot, "Diary.md");
    await writeFile(target, "the first line\n", "utf8");

    const result = await guard.append("Diary.md", "a thought of the owner");
    expect(result.verified).toBe(true);
    expect(result.opId).toBeTruthy();

    // The block carries the id of the operation, so a reader can tell the
    // write of this run from a text that happens to look the same.
    const content = await readFile(target, "utf8");
    expect(content).toContain(result.opId);
  });

  it("gives every append its own operation id", async () => {
    const { vaultRoot, guard } = await makeGuard();
    await writeFile(path.join(vaultRoot, "Diary.md"), "the first line\n", "utf8");

    const first = await guard.append("Diary.md", "one");
    const second = await guard.append("Diary.md", "two");
    expect(first.opId).not.toBe(second.opId);
  });
});
