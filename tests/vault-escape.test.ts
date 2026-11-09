import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { saveAttachment } from "../src/vault/attachments.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";
import { VaultPathError } from "../src/vault/paths.js";

const logger = createLogger("error", "test");

/**
 * A05: a link inside the vault must not lead outside of it.
 *
 * Every link in these tests is created inside the temporary stand of the test
 * and points at a folder next to it, which is also part of the stand. Nothing
 * outside of the temporary folder is touched.
 */
async function makeWorld() {
  const root = await mkdtemp(path.join(tmpdir(), "escape-"));
  const vaultRoot = path.join(root, "vault");
  const outside = path.join(root, "outside");
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(outside, { recursive: true });

  // A file that must never be readable through the vault.
  await writeFile(path.join(outside, "sentinel.txt"), "a secret outside the vault", "utf8");

  const guard = new VaultGuard({
    vaultRoot,
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

  return { root, vaultRoot, outside, guard, vault };
}

describe("A05: a link inside the vault does not lead outside", () => {
  it("does not read a file through a link to a folder outside", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    await symlink(outside, path.join(vaultRoot, "escape"), "junction");

    await expect(vault.readFile("escape/sentinel.txt")).rejects.toThrow(VaultPathError);
  });

  it("does not write a file through a link to a folder outside", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    await symlink(outside, path.join(vaultRoot, "escape"), "junction");

    await expect(
      vault.writeNote("escape/created.md", "a note that must not land outside"),
    ).rejects.toThrow(VaultPathError);
    await expect(readFile(path.join(outside, "created.md"), "utf8")).rejects.toThrow();
  });

  it("does not append through a link to a folder outside", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    await writeFile(path.join(outside, "note.md"), "outside text", "utf8");
    await symlink(outside, path.join(vaultRoot, "escape"), "junction");

    await expect(vault.appendNote("escape/note.md", "a block")).rejects.toThrow(VaultPathError);
    const content = await readFile(path.join(outside, "note.md"), "utf8");
    expect(content).toBe("outside text");
  });

  it("does not delete a file through a link to a folder outside", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    await symlink(outside, path.join(vaultRoot, "escape"), "junction");

    await expect(vault.deleteNote("escape/sentinel.txt")).rejects.toThrow(VaultPathError);
    const content = await readFile(path.join(outside, "sentinel.txt"), "utf8");
    expect(content).toContain("a secret outside the vault");
  });

  it("does not read a file through a link that is the file itself", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    // A link to a file needs a privilege on Windows, so the test skips the
    // case where the system does not allow it to be created at all. The
    // folder case above covers the same code path.
    const created = await symlink(
      path.join(outside, "sentinel.txt"),
      path.join(vaultRoot, "linked.md"),
      "file",
    )
      .then(() => true)
      .catch(() => false);
    if (!created) return;

    await expect(vault.readFile("linked.md")).rejects.toThrow(VaultPathError);
  });

  it("does not write through a link that is the file itself", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    const created = await symlink(
      path.join(outside, "sentinel.txt"),
      path.join(vaultRoot, "linked.md"),
      "file",
    )
      .then(() => true)
      .catch(() => false);
    if (!created) return;

    await expect(vault.writeNote("linked.md", "overwritten")).rejects.toThrow(VaultPathError);
    const content = await readFile(path.join(outside, "sentinel.txt"), "utf8");
    expect(content).toContain("a secret outside the vault");
  });

  it("does not walk into a link while listing the vault", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    await writeFile(path.join(outside, "hidden.md"), "a note outside the vault", "utf8");
    await symlink(outside, path.join(vaultRoot, "escape"), "junction");

    // A listing must not report the notes of the outside folder as notes of
    // the vault: the app would show them and the agent would read them.
    const notes = await vault.listNotes();
    const paths = notes.map((note) => note.relativePath);
    expect(paths.some((value) => value.includes("hidden.md"))).toBe(false);
    expect(paths.some((value) => value.startsWith("escape/"))).toBe(false);
  });

  it("does not read a binary file through a link", async () => {
    const { vaultRoot, outside, vault } = await makeWorld();
    await symlink(outside, path.join(vaultRoot, "escape"), "junction");

    await expect(vault.readBinary("escape/sentinel.txt")).rejects.toThrow(VaultPathError);
  });

  it("does not save an attachment into a linked folder", async () => {
    const { vaultRoot, outside } = await makeWorld();
    // The attachments folder itself is a link to the outside.
    await symlink(outside, path.join(vaultRoot, "attachments"), "junction");

    await expect(
      saveAttachment(vaultRoot, "photo.jpg", new Uint8Array([1, 2, 3]), "2026-11-09"),
    ).rejects.toThrow(VaultPathError);
    await expect(readFile(path.join(outside, "2026-11-09_photo.jpg"))).rejects.toThrow();
  });

  it("still writes a normal note inside the vault", async () => {
    const { vaultRoot, vault } = await makeWorld();
    await vault.writeNote("Normal.md", "a normal note");

    const content = await readFile(path.join(vaultRoot, "Normal.md"), "utf8");
    expect(content).toContain("a normal note");
  });

  it("still writes into a real sub folder of the vault", async () => {
    const { vaultRoot, vault } = await makeWorld();
    await vault.writeNote("projects/Plan.md", "a plan");

    const content = await readFile(path.join(vaultRoot, "projects", "Plan.md"), "utf8");
    expect(content).toContain("a plan");
  });

  it("refuses a path that climbs out with dots", async () => {
    const { vault } = await makeWorld();
    await expect(vault.readFile("../outside/sentinel.txt")).rejects.toThrow(VaultPathError);
  });
});
