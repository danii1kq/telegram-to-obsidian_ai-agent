import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRealInsideVault, toRelative } from "./paths.js";
import type { VaultWatcher } from "./watcher.js";

/** Error codes that mean "somebody else is touching the file right now". */
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ETXTBSY", "ENOTEMPTY", "EEXIST"]);

export class VaultWriteError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "VaultWriteError";
  }
}

/**
 * Raised when a note was changed by another program in a way that cannot be
 * merged with the write of the bot.
 *
 * The two versions are both kept: the note keeps the text of the other
 * program, and the text of the bot is written next to it. The caller is told,
 * because a conflict is not a success.
 */
export class VaultConflictError extends Error {
  constructor(
    message: string,
    readonly relativePath: string,
    readonly keptFile: string,
  ) {
    super(message);
    this.name = "VaultConflictError";
  }
}

export type WriteAction = "create" | "overwrite" | "append";

export interface WriteResult {
  action: WriteAction;
  /** Absolute path of the written file. */
  path: string;
  /** Path relative to the vault root. */
  relativePath: string;
  /** File name of the note without the extension. */
  title: string;
  bytes: number;
  /** True when the content was read back unchanged after the write. */
  verified: boolean;
  attempts: number;
  /** Syncthing conflict copies found next to the file. */
  conflictFiles: string[];
  notes: string[];
  /**
   * The identity of this write.
   *
   * An append carries it in the note, so the check after the write looks for
   * the block of this very operation instead of looking for a text that may
   * have been there before.
   */
  opId?: string;
}

export interface VaultGuardOptions {
  vaultRoot: string;
  retryDelayMs?: number;
  maxAttempts?: number;
  settleDelayMs?: number;
  /** Delay between the write and the verification read. */
  verifyDelayMs?: number;
  watcher?: VaultWatcher;
  sleep?: (ms: number) => Promise<void>;
}

export interface AppendOptions {
  /**
   * Called right before the write of an attempt.
   *
   * The tests use it to put an external change between the read and the write,
   * which is exactly the race the append has to survive. In production it is
   * not set.
   */
  beforeWrite?: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Writes notes in a way that survives Syncthing.
 *
 * Every write goes to a temporary file in the same directory and is then
 * renamed over the target, so a reader never sees a half written note. The
 * rename is atomic, and that is all it is: it does not stop another program
 * from writing the same file between the read and the rename. An append
 * therefore reads the file again on every attempt and applies its own block to
 * the version it just read, and the check after the write looks for the id of
 * that operation, not for the text of the whole old file.
 */
export class VaultGuard {
  readonly vaultRoot: string;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly settleDelayMs: number;
  private readonly verifyDelayMs: number;
  private readonly watcher: VaultWatcher | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: VaultGuardOptions) {
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.settleDelayMs = options.settleDelayMs ?? 1000;
    this.verifyDelayMs = options.verifyDelayMs ?? 400;
    this.watcher = options.watcher;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Overwrites (or creates) a note. */
  async write(targetPath: string, content: string): Promise<WriteResult> {
    const absolute = await resolveRealInsideVault(this.vaultRoot, targetPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const existed = await this.exists(absolute);
    const payload = content.endsWith("\n") ? content : `${content}\n`;

    return this.runWithRetry(absolute, payload, existed ? "overwrite" : "create");
  }

  /**
   * Appends a block to a note without ever truncating existing content.
   *
   * The payload is built inside the attempt, from the version of the file that
   * was read for that attempt. A retry after a conflict therefore applies the
   * block to the new version instead of writing the old text again, which used
   * to drop whatever the other program had written in between.
   */
  async append(
    targetPath: string,
    block: string,
    options: AppendOptions = {},
  ): Promise<WriteResult> {
    const absolute = await resolveRealInsideVault(this.vaultRoot, targetPath);
    await mkdir(path.dirname(absolute), { recursive: true });

    const opId = randomBytes(8).toString("hex");
    const notes: string[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.settle(absolute);

        // The version this attempt works on. It is read again on every
        // attempt, so an external change is part of the next payload.
        const current = await this.readIfExists(absolute);
        const payload = buildAppendPayload(current, block, opId);

        await options.beforeWrite?.();

        // The write only lands if the file still holds the version the payload
        // was built from. A change that arrived in between is not overwritten:
        // the attempt is thrown away and the next one starts from the new
        // version. The check and the rename are not one atomic step, so a
        // change in that last instant is still possible; it is caught by the
        // check after the write, which then retries instead of reporting a
        // success.
        const stillCurrent = await this.readIfExists(absolute);
        if (stillCurrent !== current) {
          notes.push(`attempt ${attempt}: the file changed before the write, retrying`);
          await this.sleep(this.retryDelayMs);
          continue;
        }

        await this.atomicWrite(absolute, payload);

        const verification = await this.verifyAppend(absolute, opId);
        if (verification.ok) {
          const conflictFiles = await this.findConflictFiles(absolute);
          return {
            action: "append",
            path: absolute,
            relativePath: toRelative(this.vaultRoot, absolute),
            title: path.basename(absolute).replace(/\.md$/i, ""),
            bytes: Buffer.byteLength(payload, "utf8"),
            verified: true,
            attempts: attempt,
            conflictFiles,
            notes: [...notes, ...verification.notes],
            opId,
          };
        }

        notes.push(verification.note);
        lastError = new Error(verification.note);
        await this.sleep(this.retryDelayMs);
      } catch (error) {
        if (!isTransient(error)) throw error;
        lastError = error;
        notes.push(`attempt ${attempt}: ${errorCode(error) ?? "unknown error"}`);
        await this.sleep(this.retryDelayMs);
      }
    }

    throw new VaultWriteError(
      `Could not append to ${toRelative(this.vaultRoot, absolute)} after ${this.maxAttempts} attempts: ${
        (lastError as Error | undefined)?.message ?? "unknown error"
      }`,
      this.maxAttempts,
    );
  }

  /**
   * Deletes a file of the vault.
   *
   * The file is moved out of the way first and removed afterwards, so a reader
   * that has the note open never sees it disappear in the middle of a read.
   */
  async remove(targetPath: string): Promise<{ removed: boolean; relativePath: string }> {
    const absolute = await resolveRealInsideVault(this.vaultRoot, targetPath);
    const relativePath = toRelative(this.vaultRoot, absolute);
    if (!(await this.exists(absolute))) {
      return { removed: false, relativePath };
    }

    await this.settle(absolute);
    const trash = path.join(
      path.dirname(absolute),
      `.${path.basename(absolute)}.${randomBytes(6).toString("hex")}.deleted`,
    );
    try {
      await rename(absolute, trash);
    } catch (error) {
      if (!isTransient(error)) throw error;
      await rm(absolute, { force: true });
      return { removed: true, relativePath };
    }
    await rm(trash, { force: true });
    return { removed: true, relativePath };
  }

  private async runWithRetry(
    absolute: string,
    payload: string,
    action: WriteAction,
  ): Promise<WriteResult> {
    const notes: string[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.settle(absolute);
        await this.atomicWrite(absolute, payload);

        const verification = await this.verify(absolute, payload);
        if (verification.ok) {
          const conflictFiles = await this.findConflictFiles(absolute);
          return {
            action,
            path: absolute,
            relativePath: toRelative(this.vaultRoot, absolute),
            title: path.basename(absolute).replace(/\.md$/i, ""),
            bytes: Buffer.byteLength(payload, "utf8"),
            verified: true,
            attempts: attempt,
            conflictFiles,
            notes: [...notes, ...verification.notes],
          };
        }

        notes.push(verification.note);
        lastError = new Error(verification.note);
        await this.sleep(this.retryDelayMs);
      } catch (error) {
        if (!isTransient(error)) throw error;
        lastError = error;
        notes.push(`attempt ${attempt}: ${errorCode(error) ?? "unknown error"}`);
        await this.sleep(this.retryDelayMs);
      }
    }

    throw new VaultWriteError(
      `Could not write ${toRelative(this.vaultRoot, absolute)} after ${this.maxAttempts} attempts: ${
        (lastError as Error | undefined)?.message ?? "unknown error"
      }`,
      this.maxAttempts,
    );
  }

  /**
   * Waits a moment when the file looks like it is being synced right now.
   * The check uses the fs.watch based watcher when available and falls back to
   * the modification time.
   */
  private async settle(absolute: string): Promise<void> {
    const recentlyTouched =
      this.watcher?.recentlyChanged(absolute, this.settleDelayMs * 2) ?? false;
    if (!recentlyTouched) {
      const info = await this.statIfExists(absolute);
      if (info && Date.now() - info.mtimeMs < this.settleDelayMs) {
        await this.sleep(this.settleDelayMs);
      }
      return;
    }
    await this.sleep(this.settleDelayMs);
  }

  /** Writes to a temp file in the same directory and renames it over the target. */
  private async atomicWrite(absolute: string, payload: string): Promise<void> {
    const directory = path.dirname(absolute);
    const temp = path.join(
      directory,
      `.${path.basename(absolute)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temp, payload, { encoding: "utf8", flag: "wx" });
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Reads the file back after a whole file write.
   *
   * The content has to be exactly what was written: a different text means
   * another program wrote the file after the bot, and the bot tries again.
   */
  private async verify(
    absolute: string,
    payload: string,
  ): Promise<{ ok: boolean; note: string; notes: string[] }> {
    await this.sleep(this.verifyDelayMs);
    const actual = await this.readIfExists(absolute);
    if (actual === null) {
      return { ok: false, note: "file disappeared right after the write", notes: [] };
    }
    if (actual === payload) {
      return { ok: true, note: "", notes: [] };
    }
    return {
      ok: false,
      note: "the file changed right after the write, retrying",
      notes: ["the file changed right after the write, retrying"],
    };
  }

  /**
   * Reads the file back after an append and looks for the id of this very
   * operation.
   *
   * Looking for the whole old payload was the bug: the old payload contains
   * the file as it was before the other program changed it, so a note that
   * lost an external edit still "contained" it. The id is written with the
   * block, so it proves that the block of this operation is in the file and
   * says nothing about the rest.
   */
  private async verifyAppend(
    absolute: string,
    opId: string,
  ): Promise<{ ok: boolean; note: string; notes: string[] }> {
    await this.sleep(this.verifyDelayMs);
    const actual = await this.readIfExists(absolute);
    if (actual === null) {
      return { ok: false, note: "file disappeared right after the write", notes: [] };
    }
    if (actual.includes(opId)) {
      return { ok: true, note: "", notes: [] };
    }
    return {
      ok: false,
      note: "the block of this operation is not in the file, retrying",
      notes: ["the block of this operation is not in the file, retrying"],
    };
  }

  /** Syncthing writes conflicts as `<name>.sync-conflict-<date>-<time>.md`. */
  private async findConflictFiles(absolute: string): Promise<string[]> {
    const directory = path.dirname(absolute);
    const base = path.basename(absolute);
    const stem = base.replace(/\.md$/i, "");
    try {
      const entries = await readdir(directory);
      return entries
        .filter(
          (entry) =>
            entry.startsWith(`.${stem}.sync-conflict-`) ||
            entry.startsWith(`${stem}.sync-conflict-`),
        )
        .map((entry) => path.join(directory, entry));
    } catch {
      return [];
    }
  }

  private async exists(absolute: string): Promise<boolean> {
    try {
      await access(absolute, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async statIfExists(absolute: string): Promise<{ mtimeMs: number } | null> {
    try {
      return await stat(absolute);
    } catch {
      return null;
    }
  }

  private async readIfExists(absolute: string): Promise<string | null> {
    try {
      return await readFile(absolute, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }
}

/**
 * The block as it goes into the note.
 *
 * The id of the operation is written as a comment at the end of the block. It
 * is invisible in Obsidian, it does not change the text the owner reads, and
 * it lets the check after the write find the block of this operation.
 */
export function markedBlock(block: string, opId: string): string {
  const body = block.endsWith("\n") ? block.slice(0, -1) : block;
  return `${body}\n<!-- op:${opId} -->\n`;
}

/**
 * Builds the payload of an append from the version that was just read.
 *
 * The separator keeps the blocks apart without adding blank lines to a note
 * that already ends with them.
 */
export function buildAppendPayload(current: string | null, block: string, opId: string): string {
  const marked = markedBlock(block, opId);
  if (current === null || current === "") return marked;
  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${marked}`;
}
