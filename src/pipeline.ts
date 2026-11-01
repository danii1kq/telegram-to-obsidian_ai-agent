import type { AppConfig } from "./config.js";
import type { HermesClient } from "./hermes/client.js";
import { buildPrompt } from "./hermes/prompt.js";
import { type Language, messages } from "./i18n/index.js";
import type { Logger } from "./logger.js";
import { embedMarkdown, type SavedAttachment } from "./vault/attachments.js";
import { readEvents, type VaultEvent } from "./vault/events.js";
import { normalizeDashes, type VaultOperations } from "./vault/operations.js";
import { extractTags, mergeTags } from "./vault/tags.js";

export interface PipelineDeps {
  config: AppConfig;
  hermes: HermesClient;
  vault: VaultOperations;
  logger: Logger;
}

export interface ProcessResult {
  /** Short status line that is sent back to Telegram. */
  status: string;
  action: "create" | "overwrite" | "append" | "none";
  title: string;
  path: string;
  usedFallback: boolean;
  agentText: string;
  /** The block that was appended, so the append can be undone. */
  block?: string;
  /** The size of the note after the write, in bytes. */
  bytes: number;
}

/**
 * The whole pipeline of one message: the text goes to Hermes Agent, the agent
 * works with the vault, and the bot reports what happened in one line.
 */
export async function processMessage(
  text: string,
  telegramUserId: number,
  deps: PipelineDeps,
  options: { attachment?: SavedAttachment; language?: Language } = {},
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const language = options.language ?? "en";
  const titles = await deps.vault.noteTitles();
  const tags = extractTags(text);
  const attachment = options.attachment;

  const prompt = buildPrompt(text, {
    now: new Date(),
    timeZone: deps.config.vault.timeZone,
    vaultPath: deps.config.vault.path,
    noteTitles: titles,
    ...(attachment
      ? { attachment: { name: attachment.name, relativePath: attachment.relativePath } }
      : {}),
  });

  deps.logger.info("running the agent", {
    chars: text.length,
    model: deps.config.hermes.model,
    userId: telegramUserId,
    tags,
  });
  const run = await deps.hermes.run(prompt);
  deps.logger.info("the agent finished", {
    ok: run.ok,
    durationMs: run.durationMs,
    model: run.model,
    usedFallback: run.usedFallback,
  });

  const events = await readEvents(deps.config.vault.eventsFile);
  const fresh = events.filter((event) => Date.parse(event.at) >= startedAt - 1500);

  if (fresh.length > 0) {
    const last = fresh[fresh.length - 1] as VaultEvent;
    if (tags.length > 0) {
      await applyTags(deps.vault, last.path, tags);
    }
    if (attachment) {
      await ensureEmbed(deps.vault, last.path, attachment);
    }
    return {
      status: statusFor(last, language),
      action: last.action,
      title: last.title,
      path: last.path,
      usedFallback: false,
      agentText: run.text,
      bytes: last.bytes,
      ...(last.block ? { block: last.block } : {}),
    };
  }

  // The agent did not touch the vault. Either it failed, or it decided that
  // the message does not need a note. In both cases the message is stored
  // anyway, so the thought is never lost.
  deps.logger.warn("the agent did not write anything, using the fallback writer", {
    ok: run.ok,
    error: run.error,
  });
  return fallbackWrite(text, deps, run.text, language, attachment);
}

/** Writes the message into the vault without the agent. */
async function fallbackWrite(
  text: string,
  deps: PipelineDeps,
  agentText: string,
  language: Language,
  attachment?: SavedAttachment,
): Promise<ProcessResult> {
  const title = deriveTitle(text, language);
  const existing = await findRelatedNote(text, title, deps.vault);
  const stamp = deps.vault.currentDateTime();
  const tags = extractTags(text);
  const embed = attachment ? `\n\n${embedMarkdown(attachment.name)}\n` : "";
  const text_ = messages(language);

  if (existing) {
    const block = `## ${stamp}\n\n${text.trim()}${embed}\n`;
    const result = await deps.vault.appendNote(existing, block, { source: "fallback" });
    if (tags.length > 0) {
      await applyTags(deps.vault, result.relativePath, tags);
    }
    return {
      status: text_.noteAppended(result.title),
      action: "append",
      title: result.title,
      path: result.relativePath,
      usedFallback: true,
      agentText,
      bytes: result.bytes,
      block: normalizeDashes(block),
    };
  }

  const result = await deps.vault.createNoteFromTitle(title, `${text.trim()}${embed}`, "fallback");
  if (tags.length > 0) {
    await applyTags(deps.vault, result.relativePath, tags);
  }
  return {
    status: text_.noteCreated(result.title),
    action: "create",
    title: result.title,
    path: result.relativePath,
    usedFallback: true,
    agentText,
    bytes: result.bytes,
  };
}

/**
 * Makes sure the file of the owner is really in the note. The agent embeds
 * it by itself, but the file must not be lost when the agent forgets it.
 */
async function ensureEmbed(
  vault: VaultOperations,
  relativePath: string,
  attachment: SavedAttachment,
): Promise<void> {
  const file = await vault.readFile(relativePath).catch(() => null);
  if (!file) return;
  const embed = embedMarkdown(attachment.name);
  if (file.content.includes(embed)) return;
  await vault.appendNote(relativePath, `\n${embed}\n`, { source: "agent" }).catch(() => undefined);
}

/**
 * Puts the tags of the message into the frontmatter of the note. The agent
 * may or may not have done it, so the tags are added here as well: the note
 * always carries them.
 */
async function applyTags(
  vault: VaultOperations,
  relativePath: string,
  tags: string[],
): Promise<void> {
  const file = await vault.readFile(relativePath).catch(() => null);
  if (!file) return;
  const merged = mergeTags(file.content, tags, vault.currentDate());
  if (merged === file.content) return;
  await vault
    .writeNote(relativePath, merged, { source: "agent", autoLink: false })
    .catch(() => undefined);
}

/** Looks for a note that is about the same topic as the message. */
async function findRelatedNote(
  text: string,
  title: string,
  vault: VaultOperations,
): Promise<string | null> {
  const keywords = extractKeywords(text);
  if (keywords.length === 0) return null;

  for (const keyword of keywords) {
    const hits = await vault.searchFiles({ target: "files", pattern: keyword });
    if (hits.length > 0) {
      return (hits[0] as { relativePath: string }).relativePath;
    }
  }

  const exact = await vault.searchFiles({ target: "files", pattern: title });
  if (exact.length > 0) {
    return (exact[0] as { relativePath: string }).relativePath;
  }
  return null;
}

/** Builds a short title out of the message. */
export function deriveTitle(text: string, language: Language = "en"): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? text;
  const cleaned = firstLine
    .replace(/[#>*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return messages(language).untitledNote;
  const words = cleaned.split(" ").slice(0, 7).join(" ");
  return words.length > 60 ? `${words.slice(0, 57)}...` : words;
}

/** Words that are likely to appear in the title of a related note. */
export function extractKeywords(text: string): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "that",
    "this",
    "with",
    "from",
    "have",
    "has",
    "was",
    "were",
    "but",
    "not",
    "you",
    "your",
    "our",
    "его",
    "как",
    "что",
    "это",
    "для",
    "или",
    "но",
    "так",
    "все",
    "она",
    "они",
    "мой",
    "моя",
    "мои",
    "чтобы",
    "если",
    "уже",
    "ещё",
    "еще",
    "который",
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((word) => word.trim())
        .filter((word) => word.length > 3 && !stop.has(word)),
    ),
  ].slice(0, 6);
}

/** The status line of a write, in the language of the owner. */ function statusFor(
  event: VaultEvent,
  language: Language,
): string {
  const text = messages(language);
  switch (event.action) {
    case "create":
      return text.noteCreated(event.title);
    case "overwrite":
      return text.noteUpdated(event.title);
    case "append":
      return text.noteAppended(event.title);
    default:
      return text.noteUpdated(event.title);
  }
}
