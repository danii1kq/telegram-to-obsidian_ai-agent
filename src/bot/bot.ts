import { Bot, type Context, InlineKeyboard } from "grammy";
import type { AppConfig } from "../config.js";
import { isLanguage, LANGUAGE_NAMES, type Language, messages } from "../i18n/index.js";
import type { Logger } from "../logger.js";
import { AttachmentTooBigError, describeAttachment, downloadAttachment } from "./attachments.js";

export interface BotDeps {
  config: AppConfig;
  logger: Logger;
  /** Runs the whole pipeline for a text message. */
  onText: (text: string, userId: number, chatId: number, language: Language) => Promise<void>;
  /** Short status text of the bot, shown for /status. */
  onStatus: (userId: number, language: Language) => Promise<string>;
  /** Searches the vault, shown for /search. */
  onSearch: (query: string, userId: number, language: Language) => Promise<string>;
  /** Undoes the last write of the bot, shown for /undo. */
  onUndo: (userId: number, confirmed: boolean, language: Language) => Promise<string>;
  /** Lists the notes of the inbox, shown for /inbox. */
  onInbox: (userId: number, language: Language) => Promise<string>;
  /** Makes the summary of a day, shown for /summary. */
  onSummary: (day: string, userId: number, language: Language) => Promise<string>;
  /** The language of the user, from the database. */
  getLanguage: (userId: number) => Promise<Language>;
  /** Remembers the language the user has chosen. */
  setLanguage: (userId: number, language: Language) => Promise<void>;
  /** Saves a file of the owner and writes a note about it. */
  onAttachment: (input: {
    caption: string;
    file: { name: string; data: Uint8Array };
    userId: number;
    chatId: number;
    language: Language;
  }) => Promise<void>;
}

/**
 * Creates the Telegram bot.
 *
 * The owner filter is the very first middleware: a message from anybody else
 * is dropped without an answer, so the bot stays a private tool.
 */
export function createBot(deps: BotDeps): Bot {
  const { config, logger } = deps;
  const bot = new Bot(config.telegram.botToken);

  bot.catch((error) => {
    logger.error("telegram error", { error: error.message });
  });

  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) return;
    if (!config.telegram.allowedUserIds.has(from.id)) {
      logger.warn("ignored a message from a user that is not allowed", {
        userId: from.id,
        username: from.username,
      });
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const language = await deps.getLanguage(ctx.from?.id ?? 0);
    await ctx.reply(messages(language).help);
  });

  bot.command("help", async (ctx) => {
    const language = await deps.getLanguage(ctx.from?.id ?? 0);
    await ctx.reply(messages(language).help);
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const language = await deps.getLanguage(userId);
    await ctx.reply(await deps.onStatus(userId, language));
  });

  bot.command("search", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const language = await deps.getLanguage(userId);
    const query = ctx.match?.trim() ?? "";
    await ctx.reply(await deps.onSearch(query, userId, language));
  });

  bot.command("inbox", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const language = await deps.getLanguage(userId);
    await ctx.reply(await deps.onInbox(userId, language));
  });

  bot.command("undo", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const language = await deps.getLanguage(userId);
    const confirmed = (ctx.match ?? "").trim().toLowerCase() === "confirm";
    await ctx.reply(await deps.onUndo(userId, confirmed, language));
  });

  bot.command("summary", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const language = await deps.getLanguage(userId);
    const day = (ctx.match ?? "").trim();
    await ctx.reply(await deps.onSummary(day, userId, language));
  });

  // The language of the bot: with an argument it is set at once, without it
  // the bot offers the two languages.
  bot.command("language", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const language = await deps.getLanguage(userId);
    const argument = (ctx.match ?? "").trim().toLowerCase();

    if (argument) {
      if (!isLanguage(argument)) {
        await ctx.reply(messages(language).languageUnknown);
        return;
      }
      await deps.setLanguage(userId, argument);
      await ctx.reply(messages(argument).languageChanged(LANGUAGE_NAMES[argument]));
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("English", "lang:en")
      .row()
      .text("Русский", "lang:ru");
    await ctx.reply(messages(language).languageButton, { reply_markup: keyboard });
  });

  for (const language of ["en", "ru"] as Language[]) {
    bot.callbackQuery(`lang:${language}`, async (ctx) => {
      const userId = ctx.from?.id ?? 0;
      await deps.setLanguage(userId, language);
      await ctx.answerCallbackQuery({
        text: messages(language).languageChanged(LANGUAGE_NAMES[language]),
      });
    });
  }

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;
    const userId = ctx.from?.id ?? 0;
    const chatId = ctx.chat?.id ?? 0;
    const language = await deps.getLanguage(userId);
    await deps.onText(text, userId, chatId, language);
  });

  // A file of the owner: it is saved in the vault and gets a note.
  const handleFile = async (ctx: Context): Promise<void> => {
    const attachment = describeAttachment(ctx);
    if (!attachment) return;

    const userId = ctx.from?.id ?? 0;
    const chatId = ctx.chat?.id ?? 0;
    const caption = ctx.message?.caption?.trim() ?? "";
    const language = await deps.getLanguage(userId);

    try {
      const data = await downloadAttachment(bot, config.telegram.botToken, attachment.fileId);
      await deps.onAttachment({
        caption,
        file: { name: attachment.fileName, data },
        userId,
        chatId,
        language,
      });
    } catch (error) {
      // The limit is the only failure the owner can do something about, so it
      // is the only one that gets the message about the size.
      if (error instanceof AttachmentTooBigError) {
        logger.warn("a file of the owner is over the limit", {
          fileName: attachment.fileName,
          bytes: error.bytes,
          limit: error.limit,
        });
        await ctx.reply(messages(language).fileTooBig("20 MB")).catch(() => undefined);
        return;
      }
      logger.error("could not save the file", {
        error: String(error),
        fileName: attachment.fileName,
      });
      await ctx.reply(messages(language).errorSave).catch(() => undefined);
    }
  };

  bot.on("message:document", handleFile);
  bot.on("message:photo", handleFile);
  bot.on("message:video", handleFile);
  bot.on("message:audio", handleFile);
  bot.on("message:voice", handleFile);

  return bot;
}
