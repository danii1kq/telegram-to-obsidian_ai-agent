import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Raised when a path would escape the vault root. */
export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

/**
 * Resolves a caller supplied path against the vault root and guarantees the
 * result stays inside the vault. The agent may pass absolute paths (the
 * Obsidian skill works with absolute paths) or paths relative to the vault.
 *
 * This is the lexical half of the check: it stops `..`, an absolute path and a
 * null byte. It cannot see a link, because a link is a fact about the disk and
 * not about the string. Use `resolveRealInsideVault` before touching a file.
 */
export function resolveInsideVault(vaultRoot: string, candidate: string): string {
  const root = path.resolve(vaultRoot);
  const raw = candidate.trim();
  if (!raw) {
    throw new VaultPathError("Empty path");
  }
  if (raw.includes("\0")) {
    throw new VaultPathError("Path contains a null byte");
  }

  const target = path.resolve(root, raw);
  const relative = path.relative(root, target);
  if (relative === "") return root;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VaultPathError(`Path escapes the vault: ${candidate}`);
  }
  return target;
}

/** True when the path is the root itself or sits below it. */
export function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolves a path and proves that its real location is inside the vault.
 *
 * A lexical check is not enough: a junction or a symlink inside the vault
 * points anywhere, and `readFile` follows it. The check here resolves the real
 * path of the deepest part of the target that exists, so a link in any parent
 * folder is seen as well, and it refuses the path when the real location is
 * outside the root.
 *
 * The target itself may not exist yet: a new note has no real path. In that
 * case the real path of its nearest existing parent is used, which is the
 * folder the file would be created in.
 *
 * This is a check before the operation, not a lock. Another process can
 * replace a folder with a link between the check and the write, and no amount
 * of checking closes that window without opening every file relative to a
 * handle. What it does close is the case that matters here: a link that is
 * already in the tree, put there by the owner, by a sync client or by the
 * agent itself.
 */
export async function resolveRealInsideVault(
  vaultRoot: string,
  candidate: string,
): Promise<string> {
  const root = path.resolve(vaultRoot);
  const target = resolveInsideVault(root, candidate);

  // The root itself is the boundary. Its real path is taken when it exists:
  // on Windows the vault may be reached through a junction, and then the real
  // path of the root is not the string the configuration holds. A vault that
  // does not exist yet is created by the first write, so its nearest existing
  // parent is used instead: the path is still compared against the place the
  // root will really be.
  const realRoot = await realpathOfNearest(root);

  // The target itself is a link when it exists and its real path is somewhere
  // else. This is checked before the resolution below, because the resolution
  // follows the link and would report the place it points at, which may well
  // be inside the vault: a link named `note.md` that points at a file outside
  // is still a link that leads outside.
  const info = await lstat(target).catch(() => null);
  if (info?.isSymbolicLink()) {
    throw new VaultPathError(`Path is a link: ${candidate}`);
  }

  const realTarget = await realpathOfNearest(target);
  if (!isInsideRoot(realRoot, realTarget)) {
    throw new VaultPathError(`Path escapes the vault through a link: ${candidate}`);
  }

  return target;
}

/**
 * The real path of a path that may not exist yet.
 *
 * The deepest existing ancestor is resolved, and the rest of the path is
 * appended to it. A path whose ancestor is a link therefore resolves to the
 * place the link points at, which is exactly what has to be compared with the
 * root.
 */
async function realpathOfNearest(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) {
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    }
    const parent = path.dirname(current);
    // Reached the root of the volume without finding anything that exists.
    if (parent === current) return target;
    missing.push(path.basename(current));
    current = parent;
  }
}

/** Absolute path -> path relative to the vault root (posix separators). */
export function toRelative(vaultRoot: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(absolutePath));
  return relative.split(path.sep).join("/");
}

/**
 * Turns a note title into a safe file name. Obsidian titles may contain
 * slashes, quotes or colons; the file name must not. A long dash becomes a
 * simple hyphen.
 */
export function sanitizeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/[—–‒―]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  const safe = cleaned.length > 0 ? cleaned : "Untitled";
  return safe.length > 120 ? safe.slice(0, 120).trim() : safe;
}

/** Builds the file name of a note from its title. */
export function noteFileName(title: string): string {
  const base = sanitizeFileName(title);
  return base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
}
