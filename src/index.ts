import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { desc } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import { buildStatus, listInbox, searchNotes, undoLast } from "./bot/actions.js";
import { createBot } from "./bot/bot.js";
import { MessageQueue } from "./bot/queue.js";
import { loadConfig } from "./config.js";
import { startDailyScheduler } from "./daily/scheduler.js";
import {
  catchUpDailySummaries,
  runDailySummary,
  type SummaryNotice,
  summaryNotice,
} from "./daily/summary.js";
import { localDate, previousDay } from "./daily/time.js";
import { createDatabase } from "./db/index.js";
import { dailySummaries, notesLog, processedUpdates, undoLog } from "./db/schema.js";
import { HermesClient } from "./hermes/client.js";
import { type Language, messages } from "./i18n/index.js";
import { createLlmProxy } from "./llm/proxy.js";
import { createLogger, type Logger } from "./logger.js";
import { createMiniApp } from "./miniapp/api.js";
import { setMenuButton } from "./miniapp/menu.js";
import { type ProcessResult, processMessage } from "./pipeline.js";
import { resolveLanguage, saveLanguage } from "./settings/language.js";
import { saveAttachment } from "./vault/attachments.js";
import { VaultGuard } from "./vault/guard.js";
import { VaultOperations } from "./vault/operations.js";
import { VaultWatcher } from "./vault/watcher.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, "bot");
  const startedAt = Date.now();

  logger.info("starting", {
    vault: config.vault.path,
    model: config.hermes.model,
    fallbackModel: config.hermes.fallbackModel,
    allowedUsers: [...config.telegram.allowedUserIds],
  });

  await mkdir(config.vault.path, { recursive: true });
  await mkdir(path.dirname(path.resolve(config.db.path)), { recursive: true });
  await mkdir(path.dirname(path.resolve(config.vault.eventsFile)), { recursive: true });

  const { client, db } = await createDatabase(config.db.path);

  const watcher = new VaultWatcher(config.vault.path);
  watcher.start();

  const guard = new VaultGuard({
    vaultRoot: config.vault.path,
    retryDelayMs: config.vault.retryDelayMs,
    maxAttempts: config.vault.maxAttempts,
    settleDelayMs: config.vault.settleDelayMs,
    watcher,
  });

  const vault = new VaultOperations({
    guard,
    eventsFile: config.vault.eventsFile,
    timeZone: config.vault.timeZone,
    logger: logger.child("vault"),
  });

  // The model provider is reached through a local proxy: it adds the session
  // header the OpenCode Go relay requires and keeps the key out of the agent.
  const proxy = createLlmProxy({
    host: config.llm.proxyHost,
    port: config.llm.proxyPort,
    targetBaseUrl: config.llm.providerBaseUrl,
    apiKey: config.llm.apiKey,
    sessionId: config.llm.sessionId || `tg-obsidian-${process.pid}`,
    logger: logger.child("llm"),
  });
  await proxy.start();

  const hermes = new HermesClient({
    bin: config.hermes.bin,
    model: config.hermes.model,
    fallbackModel: config.hermes.fallbackModel,
    timeoutMs: config.hermes.timeoutMs,
    maxTurns: config.hermes.maxTurns,
    workspace: config.hermes.workspace,
    env: process.env,
    logger: logger.child("hermes"),
  });

  const queue = new MessageQueue(logger.child("queue"));

  const dailyDeps = {
    config,
    db,
    vault,
    hermes,
    logger: logger.child("daily"),
  };

  /** The chat of the owner, the bot writes there. */
  const ownerChatId = [...config.telegram.allowedUserIds][0] ?? 0;

  /** The language of every user, kept in the database. */
  const languageStore = {
    db,
    options: {
      defaultLanguage: config.language.default,
      ownerLanguage: config.language.owner,
      ownerIds: config.telegram.allowedUserIds,
    },
  };

  const getLanguage = (userId: number): Promise<Language> => resolveLanguage(languageStore, userId);
  const setLanguage = (userId: number, language: Language): Promise<void> =>
    saveLanguage(languageStore, userId, language);

  /** Writes the result of the pipeline into the log of the notes and of the undo. */
  const record = async (result: ProcessResult, userId: number): Promise<void> => {
    await db.insert(notesLog).values({
      createdAt: new Date().toISOString(),
      action: result.action,
      path: result.path,
      title: result.title,
      source: result.usedFallback ? "fallback" : "agent",
      bytes: result.bytes,
      telegramUserId: String(userId),
    });
    if (result.action !== "none") {
      await db.insert(undoLog).values({
        createdAt: new Date().toISOString(),
        action: result.action,
        path: result.path,
        title: result.title,
        block: result.block ?? null,
        telegramUserId: String(userId),
      });
    }
  };

  const bot: Bot = createBot({
    config,
    logger: logger.child("telegram"),
    getLanguage,
    setLanguage,
    onText: async (text, userId, chatId, language) => {
      queue.push(async () => {
        if (config.botAck) {
          await bot.api.sendMessage(chatId, config.botAck).catch(() => undefined);
        }
        try {
          const result = await processMessage(
            text,
            userId,
            { config, hermes, vault, logger: logger.child("pipeline") },
            { language },
          );
          await bot.api.sendMessage(chatId, result.status);
          await record(result, userId);
        } catch (error) {
          logger.error("could not process the message", { error: String(error) });
          await bot.api.sendMessage(chatId, messages(language).errorWrite).catch(() => undefined);
        }
      });
    },
    onAttachment: async ({ caption, file, userId, chatId, language }) => {
      queue.push(async () => {
        try {
          const saved = await saveAttachment(
            config.vault.path,
            file.name,
            file.data,
            vault.currentDate(),
          );
          logger.info("saved a file of the owner", {
            name: saved.name,
            bytes: saved.bytes,
          });

          const text = caption.trim() || messages(language).attachmentFallback(saved.name);
          const result = await processMessage(
            text,
            userId,
            { config, hermes, vault, logger: logger.child("pipeline") },
            { attachment: saved, language },
          );
          await bot.api.sendMessage(chatId, result.status);
          await record(result, userId);
        } catch (error) {
          logger.error("could not save the file", { error: String(error) });
          await bot.api.sendMessage(chatId, messages(language).errorSave).catch(() => undefined);
        }
      });
    },
    onStatus: async (_userId, language) =>
      buildStatus(
        {
          vault,
          db,
          model: config.hermes.model,
          fallbackModel: config.hermes.fallbackModel,
          queueSize: queue.size,
          uptimeMs: Date.now() - startedAt,
          now: vault.currentDateTime(),
        },
        language,
      ),
    onSearch: async (query, _userId, language) =>
      searchNotes(query, { vault, db, logger: logger.child("actions") }, language),
    onUndo: async (userId, confirmed, language) =>
      undoLast({ vault, db, logger: logger.child("actions") }, userId, language, confirmed),
    onInbox: async (_userId, language) =>
      listInbox({ vault, db, logger: logger.child("actions") }, language),
    onSummary: async (day, userId, language) => {
      const requested = /^\d{4}-\d{2}-\d{2}$/.test(day)
        ? day
        : previousDay(localDate(new Date(), config.vault.timeZone));
      const chatId = userId;

      void queue.push(async () => {
        const summary = await runDailySummary(dailyDeps, requested, language);
        if (!summary) {
          await bot.api
            .sendMessage(chatId, messages(language).summaryEmpty(requested))
            .catch(() => undefined);
          return;
        }
        const notice = summaryNotice(summary.day, config.miniApp.url, language);
        await bot.api
          .sendMessage(chatId, notice.text, summaryMarkup(notice, language))
          .catch(() => undefined);
      });

      return messages(language).summaryWorking(requested);
    },
  });

  const scheduler = startDailyScheduler({
    timeZone: config.vault.timeZone,
    logger: logger.child("daily"),
    run: async (day) => {
      await queue.push(async () => {
        const language = await getLanguage(ownerChatId);
        const summary = await runDailySummary(dailyDeps, day, language);
        if (!summary) return;
        const notice = summaryNotice(summary.day, config.miniApp.url, language);
        await bot.api
          .sendMessage(ownerChatId, notice.text, summaryMarkup(notice, language))
          .catch(() => undefined);
      });
    },
  });
  logger.info("the daily summary is scheduled", {
    next: scheduler.nextRunAt().toISOString(),
    timeZone: config.vault.timeZone,
  });

  // The name of the bot, for the button of the Mini App that opens the chat.
  let botUsername = "";
  try {
    const me = await bot.api.getMe();
    botUsername = me.username ?? "";
  } catch (error) {
    logger.warn("could not read the name of the bot", { error: String(error) });
  }

  const miniApp = createMiniApp({
    vault,
    botToken: config.telegram.botToken,
    browserToken: config.miniApp.token,
    logger: logger.child("miniapp"),
    webRoot: config.miniApp.webRoot,
    debugFile: config.miniApp.debugFile,
    botUsername: () => botUsername,
    language: (userId: number) => getLanguage(userId),
    defaultLanguage: config.language.owner,
    ownerId: ownerChatId,
    summaries: async () => {
      const rows = await db
        .select()
        .from(dailySummaries)
        .orderBy(desc(dailySummaries.date))
        .limit(30);
      return rows.map((row) => ({ date: row.date, summary: row.summary, file: row.file }));
    },
  });

  const healthServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    // The webhook of Telegram: the updates arrive here.
    if (request.method === "POST" && url.pathname === "/webhook") {
      void handleWebhook(request, response);
      return;
    }

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "telegram-to-obsidian-ai-agent" }));
      return;
    }
    void miniApp(request, response).then((handled) => {
      if (handled) return;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });
  });

  /** Takes the update of Telegram and gives it to the bot. */
  async function handleWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    // The secret is checked always: the webhook is open to the internet, and
    // without the check anybody could send updates as the owner.
    const expected = config.telegram.webhookSecret;
    const given = Array.isArray(secret) ? secret[0] : secret;
    if (!expected || given !== expected) {
      logger.warn("a webhook call came without the right secret");
      response.writeHead(403).end("forbidden");
      return;
    }

    try {
      const body = await readBody(request);
      const update = JSON.parse(body) as Parameters<typeof bot.handleUpdate>[0];

      // Telegram sends an update again when the answer did not arrive in time.
      // A message that was already handled must not be written twice.
      const updateId = typeof update.update_id === "number" ? String(update.update_id) : "";
      if (updateId && !(await claimUpdate(updateId))) {
        logger.info("an update that was already handled came again", { updateId });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, duplicate: true }));
        return;
      }

      await bot.handleUpdate(update);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      logger.error("the webhook call failed", { error: String(error) });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    }
  }

  /**
   * Remembers an update id and says whether it is new.
   *
   * The table is the one the schema already had for this purpose. A failure of
   * the database must not drop a message of the owner, so an update whose id
   * could not be written is handled anyway.
   */
  async function claimUpdate(updateId: string): Promise<boolean> {
    try {
      const inserted = await db
        .insert(processedUpdates)
        .values({ updateId, processedAt: new Date().toISOString() })
        .onConflictDoNothing()
        .returning({ updateId: processedUpdates.updateId });
      return inserted.length > 0;
    } catch (error) {
      logger.warn("could not remember the update id", { updateId, error: String(error) });
      return true;
    }
  }
  await new Promise<void>((resolve) => {
    healthServer.listen(config.health.port, config.health.host, () => {
      logger.info("health endpoint listening", {
        host: config.health.host,
        port: config.health.port,
      });
      resolve();
    });
  });

  const stop = async (signal: string) => {
    logger.info("stopping", { signal });
    scheduler.stop();
    watcher.stop();
    await proxy.stop();
    healthServer.close();
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // The button of the chat menu opens the Mini App with the notes.
  if (config.miniApp.url) {
    try {
      await setMenuButton({ botToken: config.telegram.botToken, url: config.miniApp.url });
      logger.info("the menu button opens the mini app", { url: config.miniApp.url });
    } catch (error) {
      logger.error("could not set the menu button", { error: String(error) });
    }
  }

  // The summary of the days that were missed while the bot was down.
  void queue.push(async () => {
    try {
      const language = await getLanguage(ownerChatId);
      const summaries = await catchUpDailySummaries(dailyDeps, 3, language);
      for (const summary of summaries) {
        const notice = summaryNotice(summary.day, config.miniApp.url, language);
        await bot.api
          .sendMessage(ownerChatId, notice.text, summaryMarkup(notice, language))
          .catch(() => undefined);
      }
    } catch (error) {
      logger.error("could not catch up the daily summaries", { error: String(error) });
    }
  });

  if (config.telegram.mode === "webhook" && config.telegram.webhookUrl) {
    await bot.init();
    await bot.api.setWebhook(config.telegram.webhookUrl, {
      secret_token: config.telegram.webhookSecret || undefined,
      allowed_updates: ["message"],
    });
    logger.info("the bot waits for the updates on the webhook", {
      url: config.telegram.webhookUrl,
    });
  } else {
    await startPolling(bot, logger);
  }
}

/**
 * The markup of the notice of the daily summary: the button opens the Mini
 * App with the notes.
 */
function summaryMarkup(
  notice: SummaryNotice,
  language: Language,
): { reply_markup: InlineKeyboard } | undefined {
  if (!notice.miniAppUrl) return undefined;
  return {
    reply_markup: new InlineKeyboard().webApp(messages(language).openNotes, notice.miniAppUrl),
  };
}

/**
 * Polls Telegram for the updates.
 *
 * Telegram answers with a conflict when another instance of the same bot is
 * still asking for the updates, for example right after the restart of the
 * container. The bot waits and asks again instead of falling down.
 */
async function startPolling(bot: Bot, logger: Logger): Promise<void> {
  let first = true;

  for (;;) {
    try {
      await bot.start({
        onStart: (info) => logger.info("the bot is polling Telegram", { username: info.username }),
        drop_pending_updates: first,
      });
      return;
    } catch (error) {
      logger.error("the connection to telegram failed, trying again in 15 s", {
        error: String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      first = false;
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});

/** The biggest update Telegram may send. A text message is far below it. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * Reads the body of a request.
 *
 * The webhook is open to the internet, so the body is capped: without the cap
 * a single call could fill the memory of the process.
 */
function readBody(request: IncomingMessage, maxBytes = MAX_WEBHOOK_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`the body of the request is over ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
