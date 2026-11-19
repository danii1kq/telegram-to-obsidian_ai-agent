import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultPathError } from "../src/vault/paths.js";

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "vault-guard-"));
}

describe("VaultGuard", () => {
  it("creates a note and reads it back", async () => {
    const vault = await makeVault();
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });

    const result = await guard.write("Ideas.md", "first thought");

    expect(result.action).toBe("create");
    expect(result.verified).toBe(true);
    expect(await readFile(path.join(vault, "Ideas.md"), "utf8")).toBe("first thought\n");
  });

  it("refuses to write outside of the vault", async () => {
    const vault = await makeVault();
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });

    await expect(guard.write("../escape.md", "nope")).rejects.toThrow(VaultPathError);
  });

  it("keeps the existing content when it appends", async () => {
    const vault = await makeVault();
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });

    await guard.write("Diary.md", "first entry");
    const result = await guard.append("Diary.md", "## 2026-10-20\n\nsecond entry");

    expect(result.action).toBe("append");
    const content = await readFile(path.join(vault, "Diary.md"), "utf8");
    expect(content).toContain("first entry");
    expect(content).toContain("second entry");
  });

  it("retries when the file is changed by somebody else right after the write", async () => {
    const vault = await makeVault();
    const target = path.join(vault, "Race.md");
    let sleeps = 0;
    const guard = new VaultGuard({
      vaultRoot: vault,
      settleDelayMs: 1,
      verifyDelayMs: 1,
      retryDelayMs: 1,
      sleep: async () => {
        sleeps += 1;
        // The first pause happens right after the write, this is the moment
        // where a synchronisation process would overwrite the file.
        if (sleeps === 1) {
          await writeFile(target, "written by somebody else", "utf8");
        }
      },
    });

    const result = await guard.write("Race.md", "my content");

    expect(result.attempts).toBeGreaterThan(1);
    expect(result.verified).toBe(true);
    expect(await readFile(target, "utf8")).toBe("my content\n");
  });

  it("reports the conflict copies of Syncthing", async () => {
    const vault = await makeVault();
    await writeFile(
      path.join(vault, "Diary.sync-conflict-20261020-101010-ABCDEF.md"),
      "old",
      "utf8",
    );
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });

    const result = await guard.write("Diary.md", "new");

    expect(result.conflictFiles).toHaveLength(1);
  });

  it("creates a second note when the name is taken", async () => {
    const vault = await makeVault();
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });

    const first = await guard.create("Note.md", "first thought");
    const second = await guard.create("Note.md", "second thought");

    expect(first.relativePath).toBe("Note.md");
    expect(second.relativePath).toBe("Note-2.md");
    expect(await readFile(path.join(vault, "Note.md"), "utf8")).toBe("first thought\n");
    expect(await readFile(path.join(vault, "Note-2.md"), "utf8")).toBe("second thought\n");
  });

  it("keeps counting the suffix until a free name is found", async () => {
    const vault = await makeVault();
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });

    await guard.create("Note.md", "one");
    await guard.create("Note.md", "two");
    const third = await guard.create("Note.md", "three");

    expect(third.relativePath).toBe("Note-3.md");
  });

  it("does not replace a note that appeared between the check and the write", async () => {
    const vault = await makeVault();
    const guard = new VaultGuard({ vaultRoot: vault, settleDelayMs: 1, verifyDelayMs: 1 });

    // The name is free when the write starts, and another program takes it
    // right after that. The publication must fail instead of replacing it.
    const target = path.join(vault, "Race.md");
    const result = await guard.create("Race.md", "mine");
    await writeFile(target, "the other program was here\n", "utf8");

    expect(result.relativePath).toBe("Race.md");
    const after = await readFile(target, "utf8");
    expect(after).toBe("the other program was here\n");
  });
});
