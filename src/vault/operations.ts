import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";
import { appendEvent, type VaultEvent } from "./events.js";
import type { VaultGuard, WriteResult } from "./guard.js";
import { noteFileName, resolveInsideVault, toRelative } from "./paths.js";
import { parseFrontmatter, parseTags } from "./tags.js";

export interface NoteInfo {
  relativePath: string;
  title: string;
  mtimeMs: number;
  size: number;
}

export interface SearchHit {
  relativePath: string;
  title: string;
  line?: number;
  snippet?: string;
}

/** A note with everything the list of the Mini App shows. */
export interface DetailedNote extends NoteInfo {
  date: string;
  tags: string[];
  snippet: string;
}

export interface VaultOperationsDeps {
  guard: VaultGuard;
  eventsFile: string;
  timeZone: string;
  logger: Logger;
}

const MAX_SCANNED_BYTES = 512 * 1024;
const MAX_SEARCH_HITS = 60;
/** How long a regular expression may take on a short sample before it is dropped. */
const REGEX_SAMPLE_BUDGET_MS = 50;
/** How long the titles of the notes are reused for the wiki links. */
const TITLES_CACHE_MS = 2000;

/** The long dashes that are never written into a note. */
const LONG_DASHES = /[—–‒―]/g;

/**
 * Replaces the long dashes with a simple hyphen. The agent is told not to use
 * them, and this is the guarantee that none of them reaches a note.
 */
export function normalizeDashes(text: string): string {
  return text.replace(LONG_DASHES, "-");
}

/**
 * The file operations exposed to Hermes Agent as MCP tools and used by the
 * application itself when the agent is not able to run.
 */
export class VaultOperations {
  private titlesCache: { titles: string[]; at: number } | null = null;

  constructor(private readonly deps: VaultOperationsDeps) {}

  /** The absolute path of the vault root. */
  get vaultRoot(): string {
    return this.deps.guard.vaultRoot;
  }

  /** Lists every markdown note of the vault (or of a sub folder). */
  async listNotes(relativeDir?: string): Promise<NoteInfo[]> {
    const root = relativeDir ? resolveInsideVault(this.vaultRoot, relativeDir) : this.vaultRoot;
    const notes: NoteInfo[] = [];

    const walk = async (directory: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        const info = await stat(full).catch(() => null);
        notes.push({
          relativePath: toRelative(this.vaultRoot, full),
          title: entry.name.replace(/\.md$/i, ""),
          mtimeMs: info?.mtimeMs ?? 0,
          size: info?.size ?? 0,
        });
      }
    };

    await walk(root);
    notes.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return notes;
  }

  /** Titles of all notes; used to build wiki links. */
  async noteTitles(): Promise<string[]> {
    const notes = await this.listNotes();
    return notes.map((note) => note.title);
  }

  /**
   * The titles for the wiki links, cached for a short while.
   *
   * Every write asks for the titles to link the mentions, and every ask walks
   * the whole vault. The cache is short lived and is dropped by the writes of
   * this process, so a note that appears is linked by the next message.
   */
  private async cachedTitles(): Promise<string[]> {
    const now = Date.now();
    if (this.titlesCache && now - this.titlesCache.at < TITLES_CACHE_MS) {
      return this.titlesCache.titles;
    }
    const titles = await this.noteTitles();
    this.titlesCache = { titles, at: now };
    return titles;
  }

  /** Drops the cache of the titles, the vault has a new note. */
  private invalidateTitles(): void {
    this.titlesCache = null;
  }

  /** The notes with their date, their tags and a short text. */
  async listNotesDetailed(limit = 60): Promise<DetailedNote[]> {
    const notes = await this.listNotes();

    // The notes are read side by side: a vault of a few hundred notes is a few
    // hundred independent reads, and one after another they add up.
    const detailed = await Promise.all(
      notes.slice(0, limit).map(async (note) => {
        const content = await this.readScanned(note);
        const fields = parseFrontmatter(content);
        return {
          ...note,
          date: fields.date ?? "",
          tags: parseTags(content),
          snippet: excerptOf(content),
        };
      }),
    );
    return detailed;
  }

  /**
   * Searches the vault. `files` matches note names, `content` matches the
   * text inside the notes. Both accept a glob (`*.md`) or a plain substring.
   *
   * The content is matched as a plain substring unless `regex` is set: a
   * pattern from a chat message is not a regular expression, and a pattern
   * like `(a+)+` takes the whole process down with a backtracking blowup.
   */
  async searchFiles(params: {
    target?: "files" | "content";
    pattern: string;
    path?: string;
    file_glob?: string;
    regex?: boolean;
  }): Promise<SearchHit[]> {
    const target = params.target ?? "files";
    // The pattern can be a regular expression, so it is kept short: a long
    // one can make the search slow.
    const pattern = (params.pattern?.trim() ?? "").slice(0, 200);
    if (!pattern) return [];

    const root = params.path ? resolveInsideVault(this.vaultRoot, params.path) : this.vaultRoot;
    const notes = await this.listNotes(toRelative(this.vaultRoot, root));
    const glob = params.file_glob?.trim();
    const hits: SearchHit[] = [];

    if (target === "files") {
      const matcher = buildMatcher(pattern);
      for (const note of notes) {
        if (glob && !matchesGlob(note.relativePath, glob)) continue;
        if (matcher(note.title) || matcher(note.relativePath)) {
          hits.push({ relativePath: note.relativePath, title: note.title });
        }
      }
      return hits.slice(0, MAX_SEARCH_HITS);
    }

    const contentMatcher = buildContentMatcher(pattern, params.regex === true);
    for (const note of notes) {
      if (glob && !matchesGlob(note.relativePath, glob)) continue;
      // The size is already known from the listing, so a note that is too big
      // to scan is not read at all.
      if (note.size > MAX_SCANNED_BYTES) continue;
      const content = await readFile(path.join(this.vaultRoot, note.relativePath), "utf8").catch(
        () => "",
      );
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (contentMatcher(line)) {
          hits.push({
            relativePath: note.relativePath,
            title: note.title,
            line: index + 1,
            snippet: line.trim().slice(0, 240),
          });
          if (hits.length >= MAX_SEARCH_HITS) return hits;
        }
      }
    }
    return hits;
  }

  /** Reads a note. */
  async readFile(
    targetPath: string,
  ): Promise<{ relativePath: string; content: string; lines: number }> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const content = await readFile(absolute, "utf8");
    return {
      relativePath: toRelative(this.vaultRoot, absolute),
      content,
      lines: content.split("\n").length,
    };
  }

  /** When a note was changed the last time, and how big it is. */
  async statOf(targetPath: string): Promise<{ mtimeMs: number; size: number } | null> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const info = await stat(absolute).catch(() => null);
    return info ? { mtimeMs: info.mtimeMs, size: info.size } : null;
  }

  /** Reads a file of the vault as it is, for the attachments. */
  async readBinary(targetPath: string): Promise<{ relativePath: string; data: Uint8Array }> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const data = await readFile(absolute);
    return { relativePath: toRelative(this.vaultRoot, absolute), data };
  }

  /**
   * Creates or overwrites a note. New notes always start with the Obsidian
   * YAML frontmatter and every mention of an existing note becomes a wiki link.
   */
  async writeNote(
    targetPath: string,
    content: string,
    options: { source?: VaultEvent["source"]; autoLink?: boolean } = {},
  ): Promise<WriteResult> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const titles = options.autoLink === false ? [] : await this.cachedTitles();
    const selfTitle = path.basename(absolute).replace(/\.md$/i, "");
    const linked = autoLinkEntities(normalizeDashes(content), titles, selfTitle);
    const withFrontmatter = ensureFrontmatter(linked, this.currentDate());

    // The old content is kept, so an overwrite can be undone later.
    const previous = await readFile(absolute, "utf8").catch(() => undefined);

    const result = await this.deps.guard.write(absolute, withFrontmatter);
    this.invalidateTitles();
    await this.record(result, options.source ?? "agent", {
      previous: result.action === "overwrite" ? previous : undefined,
    });
    return result;
  }

  /** Appends a block to an existing note, keeping the rest of the content. */
  async appendNote(
    targetPath: string,
    block: string,
    options: { source?: VaultEvent["source"] } = {},
  ): Promise<WriteResult> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const normalized = normalizeDashes(block);
    const result = await this.deps.guard.append(absolute, normalized);
    await this.record(result, options.source ?? "agent", { block: normalized });
    return result;
  }

  /**
   * Removes the last occurrence of a block from a note. It is the way back
   * after a wrong append, so the rest of the note stays untouched.
   */
  async removeBlock(
    targetPath: string,
    block: string,
  ): Promise<{ removed: boolean; relativePath: string }> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const relativePath = toRelative(this.vaultRoot, absolute);
    const current = await readFile(absolute, "utf8").catch(() => "");
    const index = current.lastIndexOf(block);
    if (index < 0) return { removed: false, relativePath };

    const next = `${current.slice(0, index)}${current.slice(index + block.length)}`.replace(
      /\s+$/,
      "",
    );
    await this.deps.guard.write(absolute, next);
    return { removed: true, relativePath };
  }

  /** Deletes a note of the vault. */
  async deleteNote(targetPath: string): Promise<{ removed: boolean; relativePath: string }> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const result = await this.deps.guard.remove(absolute);
    return { removed: result.removed, relativePath: result.relativePath };
  }

  /**
   * The conflict copies of Syncthing that sit next to a note.
   *
   * Syncthing names them `<note>.sync-conflict-<date>-<time>-<device>.md`.
   * They are not notes of the vault, they are the other version of a note that
   * two devices wrote at once, so the owner is told about them.
   */
  async conflictCopies(targetPath: string): Promise<string[]> {
    const absolute = resolveInsideVault(this.vaultRoot, targetPath);
    const directory = path.dirname(absolute);
    const stem = path.basename(absolute).replace(/\.md$/i, "");
    const entries = await readdir(directory).catch(() => [] as string[]);
    return entries
      .filter((entry) => entry.startsWith(`${stem}.sync-conflict-`))
      .map((entry) => toRelative(this.vaultRoot, path.join(directory, entry)));
  }

  /** Notes that carry a tag in their frontmatter, the newest first. */ async listByTag(
    tag: string,
  ): Promise<NoteInfo[]> {
    const wanted = tag.trim().toLowerCase();
    if (!wanted) return [];

    const notes = await this.listNotes();
    const matched = await Promise.all(
      notes.map(async (note) => {
        const content = await this.readScanned(note);
        const tags = parseTags(content).map((value) => value.toLowerCase());
        return tags.includes(wanted) ? note : null;
      }),
    );
    return matched.filter((note): note is NoteInfo => note !== null);
  }

  /**
   * Reads a note for a scan over the whole vault.
   *
   * The size of a note is already known from the listing, so a note that is
   * too big to scan is not read at all. A note that disappeared between the
   * listing and the read gives an empty text instead of failing the scan.
   */
  private async readScanned(note: NoteInfo): Promise<string> {
    if (note.size > MAX_SCANNED_BYTES) return "";
    return readFile(path.join(this.vaultRoot, note.relativePath), "utf8").catch(() => "");
  }

  /** Creates a note from a title, used by the fallback path. */
  async createNoteFromTitle(
    title: string,
    body: string,
    source: VaultEvent["source"] = "fallback",
  ) {
    return this.writeNote(noteFileName(title), body, { source });
  }

  /** Current date in the configured time zone (YYYY-MM-DD). */
  currentDate(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.deps.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  /** Current date and time in the configured time zone. */
  currentDateTime(): string {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: this.deps.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  }

  private async record(
    result: WriteResult,
    source: VaultEvent["source"],
    extra: { block?: string; previous?: string } = {},
  ): Promise<void> {
    const event: VaultEvent = {
      action: result.action,
      path: result.relativePath,
      title: path.basename(result.relativePath).replace(/\.md$/i, ""),
      at: new Date().toISOString(),
      bytes: result.bytes,
      source,
      ...(extra.block ? { block: extra.block } : {}),
      ...(extra.previous !== undefined ? { previous: extra.previous } : {}),
    };
    try {
      await appendEvent(this.deps.eventsFile, event);
    } catch (error) {
      this.deps.logger.warn("could not record the vault event", { error: String(error) });
    }
  }
}

/** Adds the Obsidian frontmatter when the note does not have one yet. */
export function ensureFrontmatter(content: string, date: string): string {
  const trimmed = content.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("---")) return content;
  return `---\ndate: ${date}\ntags: [inbox, telegram]\n---\n\n${content.trimStart()}`;
}

const WIKILINK = /\[\[[^\]]*\]\]/g;
const PLACEHOLDER = "\u0000";

/**
 * Wraps every mention of an existing note into a wiki link. Text that is
 * already a wiki link is left untouched, and a note never links to itself.
 */
export function autoLinkEntities(text: string, titles: string[], selfTitle: string): string {
  if (titles.length === 0) return text;

  const placeholders: string[] = [];
  const masked = text.replace(WIKILINK, (match) => {
    placeholders.push(match);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });

  const sorted = [...new Set(titles)]
    .filter((title) => title.length > 2 && title.toLowerCase() !== selfTitle.toLowerCase())
    .sort((a, b) => b.length - a.length);

  let linked = masked;
  for (const title of sorted) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\w\\[])(${escaped})(?![\\w\\]])`, "giu");
    linked = linked.replace(pattern, "[[$1]]");
  }

  return linked.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_match, index: string) => placeholders[Number(index)] ?? "",
  );
}

/** The text of a note without the frontmatter, shortened for the list. */
export function excerptOf(content: string, maxLength = 180): string {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const text = withoutFrontmatter.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/** Builds a matcher for file names: a glob when the pattern has wildcards. */
function buildMatcher(pattern: string): (value: string) => boolean {
  if (hasGlob(pattern)) {
    const regex = globToRegExp(pattern);
    return (value) => regex.test(value);
  }
  const needle = pattern.toLowerCase();
  return (value) => value.toLowerCase().includes(needle);
}

/**
 * Builds a matcher for note content.
 *
 * A plain substring is the default, because that is what a query typed by a
 * person means. A regular expression is only built when the caller asks for
 * it, and even then it is tried on a short sample first: a pattern with
 * nested quantifiers can backtrack for minutes on a single line.
 */
function buildContentMatcher(pattern: string, regex: boolean): (line: string) => boolean {
  // The needle is lowered once, not once per line: a vault has a lot of lines.
  const needle = pattern.toLowerCase();
  const plain = (line: string) => line.toLowerCase().includes(needle);
  if (!regex) return plain;

  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "i");
  } catch {
    return plain;
  }

  // A pattern that cannot answer a short line quickly is not used at all.
  const sample = "the quick brown fox jumps over the lazy dog 0123456789";
  const startedAt = Date.now();
  try {
    compiled.test(sample);
  } catch {
    return plain;
  }
  if (Date.now() - startedAt > REGEX_SAMPLE_BUDGET_MS) return plain;

  return (line) => compiled.test(line);
}

function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withStars = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${withStars}$`, "i");
}

function matchesGlob(value: string, glob: string): boolean {
  return globToRegExp(glob).test(path.basename(value)) || globToRegExp(glob).test(value);
}
