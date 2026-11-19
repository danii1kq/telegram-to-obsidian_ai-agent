import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** One vault mutation, recorded so the bot can report what actually happened. */
export interface VaultEvent {
  action: "create" | "overwrite" | "append";
  /** Path relative to the vault root. */
  path: string;
  title: string;
  at: string;
  bytes: number;
  source: "agent" | "fallback";
  /** The appended block, so the append can be undone later. */
  block?: string;
  /** The content before an overwrite, so the overwrite can be undone later. */
  previous?: string;
}

const MAX_EVENTS = 200;

async function readAll(file: string): Promise<VaultEvent[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VaultEvent[]) : [];
  } catch {
    return [];
  }
}

/** Appends an event to the shared log (atomic, so readers never see a partial file). */
export async function appendEvent(file: string, event: VaultEvent): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const events = await readAll(file);
  events.push(event);
  const payload = `${JSON.stringify(events.slice(-MAX_EVENTS), null, 2)}\n`;
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, payload, "utf8");
  await rename(temp, file);
}

/** Reads the shared event log; a broken file is treated as an empty log. */
export async function readEvents(file: string): Promise<VaultEvent[]> {
  return readAll(file);
}
