import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRealInsideVault, sanitizeFileName } from "./paths.js";

/** The folder of the vault where the files of the owner are stored. */
export const ATTACHMENTS_FOLDER = "attachments";

export type AttachmentKind = "image" | "video" | "audio" | "document";

export interface SavedAttachment {
  /** Path of the file relative to the vault root. */
  relativePath: string;
  /** The name of the file without the folder, used for the wiki link. */
  name: string;
  /** Size of the file in bytes. */
  bytes: number;
  kind: AttachmentKind;
}

/** Guesses the kind of a file from its name. */
export function attachmentKind(name: string): AttachmentKind {
  const extension = path.extname(name).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"].includes(extension)) {
    return "image";
  }
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi"].includes(extension)) return "video";
  if ([".mp3", ".ogg", ".oga", ".wav", ".m4a", ".flac"].includes(extension)) return "audio";
  return "document";
}

/**
 * Saves a file of the owner into the attachments folder of the vault.
 *
 * The file is written to a temporary name and renamed afterwards, so Syncthing
 * never sees a half written file, the same way the notes are written.
 */
export async function saveAttachment(
  vaultRoot: string,
  fileName: string,
  data: Uint8Array,
  date: string,
): Promise<SavedAttachment> {
  const root = path.resolve(vaultRoot);
  // The attachments folder is a path inside the vault like any other, so it
  // goes through the same check: a folder that is a link to somewhere else
  // would put the files of the owner outside of the vault.
  const folder = await resolveRealInsideVault(root, ATTACHMENTS_FOLDER);
  await mkdir(folder, { recursive: true });

  const safe = sanitizeFileName(fileName).replace(/\.{2,}/g, ".") || "file";
  const base = `${date}_${safe}`;
  const name = await freeName(folder, base);
  const target = await resolveRealInsideVault(root, `${ATTACHMENTS_FOLDER}/${name}`);
  const temp = path.join(folder, `.${name}.${randomBytes(6).toString("hex")}.tmp`);

  await writeFile(temp, data);
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  return {
    relativePath: `${ATTACHMENTS_FOLDER}/${name}`,
    name,
    bytes: data.byteLength,
    kind: attachmentKind(name),
  };
}

/** Finds a free name, so a file that is sent twice does not overwrite the first one. */
async function freeName(folder: string, base: string): Promise<string> {
  const exists = async (name: string) => {
    try {
      await access(path.join(folder, name));
      return true;
    } catch {
      return false;
    }
  };

  if (!(await exists(base))) return base;
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${stem}_${counter}${extension}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${stem}_${Date.now()}${extension}`;
}

/** The markdown that embeds a file into a note. */
export function embedMarkdown(name: string): string {
  return `![[${name}]]`;
}
