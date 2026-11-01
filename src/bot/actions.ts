import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { dailySummaries, notesLog, undoLog } from "../db/schema.js";
import { type Language, messages } from "../i18n/index.js";
import type { Logger } from "../logger.js";
import type { VaultOperations } from "../vault/operations.js";

export interface ActionDeps {
  vault: VaultOperations;
  db: Database["db"];
  logger: Logger;
}

export interface StatusDeps {
  vault: VaultOperations;
  db: Database["db"];
  /** The model of the agent and the model of the reserve. */
  model: string;
  fallbackModel: string;
  /** The number of the messages that wait in the queue. */
  queueSize: number;
  /** How long the bot is running, in milliseconds. */
  uptimeMs: number;
  /** The current time of the owner. */
  now: string;
}

/** The notes that wait for a confirmation of the owner. */
const pendingDeletes = new Map<string, { path: string; title: string }>();

const MAX_RESULTS = 12;

/** Searches the vault by the name of a note and by the text inside the notes. */
export async function searchNotes(
  query: string,
  deps: ActionDeps,
  language: Language,
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return messages(language).searchUsage;

  const byName = await deps.vault.searchFiles({ target: "files", pattern: trimmed });
  const byContent = await deps.vault.searchFiles({ target: "content", pattern: trimmed });

  const lines: string[] = [];
  const seen = new Set<string>();

  for (const hit of byName) {
    if (seen.has(hit.relativePath)) continue;
    seen.add(hit.relativePath);
    lines.push(`• ${hit.title} - ${hit.relativePath}`);
  }

  for (const hit of byContent) {
    if (seen.has(hit.relativePath)) continue;
    seen.add(hit.relativePath);
    lines.push(`• ${hit.title} - ${hit.relativePath}:${hit.line ?? 0}`);
    if (hit.snippet) lines.push(`  ${hit.snippet}`);
  }

  if (lines.length === 0) return messages(language).searchNotFound(trimmed);
  const shown = lines.slice(0, MAX_RESULTS);
  const hidden = lines.length - shown.length;
  const tail = hidden > 0 ? `\n${messages(language).searchMore(hidden)}` : "";
  return `${messages(language).searchHeader(trimmed)}\n${shown.join("\n")}${tail}`;
}

/** Lists the notes that are still in the inbox. */
export async function listInbox(deps: ActionDeps, language: Language): Promise<string> {
  const notes = await deps.vault.listByTag("inbox");
  if (notes.length === 0) return messages(language).inboxEmpty;
  const lines = notes.slice(0, MAX_RESULTS).map((note) => `• ${note.title} - ${note.relativePath}`);
  return `${messages(language).inboxHeader(notes.length)}\n${lines.join("\n")}`;
}

/**
 * Undoes the last write of the bot.
 *
 * An appended block is removed from the note, an overwritten note gets its
 * old content back and a created note is deleted. A note that was changed
 * after the bot wrote it is never deleted without a confirmation.
 */
export async function undoLast(
  deps: ActionDeps,
  userId: number,
  language: Language,
  confirmed = false,
): Promise<string> {
  const rows = await deps.db
    .select()
    .from(undoLog)
    .where(and(isNull(undoLog.undoneAt), eq(undoLog.telegramUserId, String(userId))))
    .orderBy(desc(undoLog.id))
    .limit(1);

  const entry = rows[0];
  if (!entry) return messages(language).undoNothing;

  const pending = pendingDeletes.get(String(userId));

  if (entry.action === "append") {
    if (!entry.block) return messages(language).undoNothing;
    const result = await deps.vault.removeBlock(entry.path, entry.block);
    if (!result.removed) {
      return messages(language).undoNotFound(entry.title);
    }
    await markUndone(deps, entry.id);
    return messages(language).undoRemoved(entry.title);
  }

  if (entry.action === "overwrite") {
    if (!entry.previous) return messages(language).undoNothing;
    await deps.vault.writeNote(entry.path, entry.previous, { source: "agent", autoLink: false });
    await markUndone(deps, entry.id);
    return messages(language).undoRestored(entry.title);
  }

  // The note was created by the bot. It is only deleted when nobody touched
  // it in the meantime, otherwise the owner has to confirm it.
  if (!confirmed) {
    const changed = await wasChangedAfter(entry.path, entry.createdAt, deps);
    if (changed) {
      pendingDeletes.set(String(userId), { path: entry.path, title: entry.title });
      return messages(language).undoConfirm(entry.title);
    }
  } else if (!pending || pending.path !== entry.path) {
    return messages(language).undoNothingToConfirm;
  }

  pendingDeletes.delete(String(userId));
  const result = await deps.vault.deleteNote(entry.path);
  if (!result.removed) return messages(language).undoNotFound(entry.title);
  await markUndone(deps, entry.id);
  return messages(language).undoDeleted(entry.title);
}

/** Marks the entry of the log as undone. */
async function markUndone(deps: ActionDeps, id: number): Promise<void> {
  await deps.db
    .update(undoLog)
    .set({ undoneAt: new Date().toISOString() })
    .where(eq(undoLog.id, id));
}
/**
 * The state of the bot: the model, the notes, the queue and the last summary
 * of the day.
 */
export async function buildStatus(deps: StatusDeps, language: Language): Promise<string> {
  const total = await deps.db.select({ value: count() }).from(notesLog);
  const notes = await deps.db.select().from(notesLog).orderBy(desc(notesLog.id)).limit(5);
  const summaries = await deps.db
    .select()
    .from(dailySummaries)
    .orderBy(desc(dailySummaries.date))
    .limit(1);

  const vaultNotes = await deps.vault.listNotes();
  const bytes = vaultNotes.reduce((sum, note) => sum + note.size, 0);

  const lines = [
    messages(language).statusRunning(uptime(deps.uptimeMs, language)),
    messages(language).statusModel(deps.model, deps.fallbackModel),
    messages(language).statusNotes(
      total[0]?.value ?? 0,
      vaultNotes.length,
      messages(language).size(bytes),
    ),
    messages(language).statusQueue(deps.queueSize),
    messages(language).statusSummary(summaries[0]?.date ?? "-"),
    messages(language).statusTime(deps.now),
  ];

  if (notes.length > 0) {
    lines.push("", messages(language).statusHeader);
    for (const note of notes) lines.push(`• ${note.title} (${note.action})`);
  }
  return lines.join("\n");
}

/** The uptime of the bot in a readable form. */
function uptime(milliseconds: number, language: Language): string {
  const text = messages(language);
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return text.uptimeDays(days, hours % 24);
  if (hours > 0) return text.uptimeHours(hours, minutes % 60);
  return text.uptimeMinutes(minutes);
}

/** True when the file was changed after the bot wrote it. */
async function wasChangedAfter(
  relativePath: string,
  createdAt: string,
  deps: ActionDeps,
): Promise<boolean> {
  const info = await deps.vault.statOf(relativePath);
  if (!info) return false;
  const writtenAt = Date.parse(createdAt);
  if (!Number.isFinite(writtenAt)) return false;
  return info.mtimeMs > writtenAt + 5_000;
}
