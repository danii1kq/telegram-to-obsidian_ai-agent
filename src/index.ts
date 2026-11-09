import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { desc } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import { buildStatus, hashOf, listInbox, searchNotes, undoLast } from "./bot/actions.js";
import { AttachmentTooBigError, downloadAttachment } from "./bot/attachments.js";
import { createBot } from "./bot/bot.js";
import { Inbox } from "./bot/inbox.js";
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
import { dailySummaries, notesLog, undoLog } from "./db/schema.js";
import { healthReport } from "./health.js";
import { HermesClient, NOTE_TOOLSETS } from "./hermes/client.js";
import { type Language, messages } from "./i18n/index.js";
import { createLlmProxy } from "./llm/proxy.js";
import { Transcriber } from "./llm/transcribe.js";
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

  // The voice messages are read by the same relay: the proxy already holds the
  // credential and the session, so the transcriber only knows the local address.
  const transcriber = new Transcriber({
    baseUrl: proxy.baseUrl,
    model: config.llm.transcribeModel,
    timeoutMs: config.llm.transcribeTimeoutMs,
    logger: logger.child("transcribe"),
  });
  if (!transcriber.enabled) {
    logger.info("the transcription of the voice messages is off, TRANSCRIBE_MODEL is empty");
  }

  /** The text of a voice message, or an empty string when it cannot be read. */
  const transcribe = async (data: Uint8Array, fileName: string): Promise<string> => {
    if (!transcriber.enabled) return "";
    const result = await transcriber.transcribe(data, fileName);
    if (!result.ok) {
      logger.warn("the voice message was not transcribed", { error: result.error });
      return "";
    }
    logger.info("the voice message is transcribed", { chars: result.text.length });
    return result.text;
  };

  const hermes = new HermesClient({
    bin: config.hermes.bin,
    model: config.hermes.model,
    fallbackModel: config.hermes.fallbackModel,
    timeoutMs: config.hermes.timeoutMs,
    maxTurns: config.hermes.maxTurns,
    workspace: config.hermes.workspace,
    env: process.env,
    // The note run works through the vault MCP server and the web tools. It
    // has no shell and no direct file tools: the vault server is the only way
    // to a note, and it is the only thing that writes one safely.
    toolsets: NOTE_TOOLSETS,
    logger: logger.child("hermes"),
  });

  const queue = new MessageQueue(logger.child("queue"));

  // The inbox is the durable half of the queue: a message is a row in the
  // database before Telegram gets an answer, and the queue in memory only runs
  // the rows. A restart finds them again.
  const inbox = new Inbox({ db, logger: logger.child("inbox") });

  const dailyDeps = {
    config,
    db,
    vault,
    hermes,
    logger: logger.child("daily"),
  };

  /** The chat of the owner, the bot writes there. */
  const ownerChatId = [...config.telegram.allowedUserIds][0] ?? 0;

  /** The moment of the last message that went through the pipeline. */
  let lastMessageAt: number | null = null;

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

  /**
   * Writes the result of the pipeline into the log of the notes and of the undo.
   *
   * The log is written before the answer goes to Telegram. The other order was
   * the bug: a failed `sendMessage` left a note that was already written with
   * no entry in the log, so the write could not be undone and the owner had no
   * record of it. A notification is a courtesy, the log is the record.
   *
   * Every write of the message is kept, not only the last one, and each one
   * carries the hash of the text the bot wrote. The undo of a created note
   * needs that hash to prove the note is still the bot's before deleting it.
   */
  const record = async (result: ProcessResult, userId: number): Promise<void> => {
    const at = new Date().toISOString();
    await db.insert(notesLog).values({
      createdAt: at,
      action: result.action,
      path: result.path,
      title: result.title,
      source: result.usedFallback ? "fallback" : "agent",
      bytes: result.bytes,
      telegramUserId: String(userId),
    });

    for (const mutation of result.mutations) {
      await db.insert(undoLog).values({
        createdAt: at,
        action: mutation.action,
        path: mutation.path,
        title: mutation.title,
        block: mutation.block ?? null,
        previous: mutation.previous ?? null,
        contentHash: mutation.content ? hashOf(mutation.content) : null,
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
          // The log first, the answer second: a failed notification must not
          // leave a written note with no record of it.
          await record(result, userId);
          lastMessageAt = Date.now();
          await bot.api
            .sendMessage(chatId, statusWithConflicts(result, language))
            .catch((error) => logger.warn("the status was not sent", { error: String(error) }));
        } catch (error) {
          logger.error("could not process the message", { error: String(error) });
          await bot.api.sendMessage(chatId, messages(language).errorWrite).catch(() => undefined);
        }
      });
    },
    onAttachment: async ({ caption, file, userId, chatId, language, audio }) => {
      queue.push(async () => {
        try {
          // The download happens here, inside the queue, so a burst of files
          // does not put several of them in memory at once.
          const data = await downloadAttachment(bot, config.telegram.botToken, file.fileId);
          const saved = await saveAttachment(
            config.vault.path,
            file.name,
            data,
            vault.currentDate(),
          );
          logger.info("saved a file of the owner", {
            name: saved.name,
            bytes: saved.bytes,
          });

          // A voice message is a thought said out loud, so it is turned into
          // text and goes through the same pipeline as a typed message. When
          // the transcription is off or fails, the file is still saved and the
          // note points at it, so nothing is lost.
          const spoken = audio ? await transcribe(data, file.name) : "";
          const text =
            spoken || caption.trim() || messages(language).attachmentFallback(saved.name);

          const result = await processMessage(
            text,
            userId,
            { config, hermes, vault, logger: logger.child("pipeline") },
            { attachment: saved, language },
          );
          // The log first, the answer second, the same as for a text message.
          await record(result, userId);
          lastMessageAt = Date.now();
          await bot.api
            .sendMessage(chatId, statusWithConflicts(result, language))
            .catch((error) => logger.warn("the status was not sent", { error: String(error) }));
        } catch (error) {
          // The limit is the only failure the owner can do something about, so
          // it is the only one that gets the message about the size.
          if (error instanceof AttachmentTooBigError) {
            logger.warn("a file of the owner is over the limit", {
              fileName: file.name,
              bytes: error.bytes,
              limit: error.limit,
            });
            await bot.api
              .sendMessage(chatId, messages(language).fileTooBig("20 MB"))
              .catch(() => undefined);
            return;
          }
          logger.error("could not save the file", { error: String(error), fileName: file.name });
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
    // The signature of Telegram says where the data came from, not who may
    // read the notes: the list of the allowed users is the second half.
    allowedUserIds: config.telegram.allowedUserIds,
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
    // The parsing of the request target is the first thing that touches a
    // value from the network, and it can throw: `GET //% HTTP/1.1` is accepted
    // by the parser of Node and then rejected by `new URL`. An exception here
    // used to leave the server, which ends the process on an uncaught error.
    void handleRequest(request, response).catch((error) => {
      logger.error("the request could not be answered", { error: String(error) });
      sendPlain(response, 500, "the server could not answer");
    });
  });

  /** Routes one request; every branch answers exactly once. */
  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      // A request target that is not a URL is a bad request, not a crash.
      logger.warn("a request came with a target that is not a url", {
        method: request.method,
        length: request.url?.length ?? 0,
      });
      sendPlain(response, 400, "bad request");
      return;
    }

    // The webhook of Telegram: the updates arrive here.
    if (request.method === "POST" && url.pathname === "/webhook") {
      await handleWebhook(request, response);
      return;
    }

    if (url.pathname === "/health") {
      // The answer is the state of the dependencies, not the fact that the
      // process is alive: the container is restarted on a failed health check.
      const report = await healthReport({
        db,
        vault,
        logger: logger.child("health"),
        queueSize: () => queue.size,
        lastMessageAt: () => lastMessageAt,
        startedAt,
        runningJobAgeMs: () => inbox.oldestRunningAgeMs(),
      });
      sendJson(response, report.ok ? 200 : 503, report);
      return;
    }

    const handled = await miniApp(request, response);
    if (handled) return;
    sendJson(response, 404, { ok: false });
  }

  /** Takes the update of Telegram and gives it to the bot. */
  async function handleWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    // The secret is checked always: the webhook is open to the internet, and
    // without the check anybody could send updates as the owner.
    const expected = config.telegram.webhookSecret;
    const given = Array.isArray(secret) ? secret[0] : secret;
    if (!expected || given !== expected) {
      logger.warn("a webhook call came without the right secret");
      sendPlain(response, 403, "forbidden");
      return;
    }

    let update: Parameters<typeof bot.handleUpdate>[0];
    try {
      const body = await readBody(request);
      update = JSON.parse(body) as Parameters<typeof bot.handleUpdate>[0];
    } catch (error) {
      logger.error("the webhook call failed", { error: String(error) });
      sendJson(response, 400, { ok: false });
      return;
    }

    const updateId = typeof update.update_id === "number" ? String(update.update_id) : "";

    // The update is written to the database before Telegram gets an answer.
    // An answer of 200 is a promise that the message will not be lost, and a
    // promise that only an in-memory queue backs up is not one: a restart
    // between the answer and the write loses the message for good.
    if (updateId) {
      try {
        const accepted = await inbox.accept({
          updateId,
          payload: JSON.stringify(update),
          telegramUserId: readUserId(update),
        });
        if (!accepted.created) {
          logger.info("an update that was already accepted came again", { updateId });
          sendJson(response, 200, { ok: true, duplicate: true });
          return;
        }
      } catch (error) {
        // Without the row there is no promise to keep, so the answer is a
        // failure and Telegram sends the update again.
        logger.error("could not accept the update", { updateId, error: String(error) });
        sendJson(response, 503, { ok: false, error: "the update was not accepted" });
        return;
      }
    }

    try {
      await bot.handleUpdate(update);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      logger.error("the webhook call failed", { error: String(error) });
      sendJson(response, 400, { ok: false });
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

  /**
   * Stops the bot within a bounded time.
   *
   * The jobs that are already running are given a moment to finish, because a
   * write that is half done is worse than a slow stop. A job that does not
   * finish in time is left in the database as running, and the next start
   * recovers it: the pipeline reads the vault to decide what actually
   * happened, so a write that landed is reported instead of repeated.
   */
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("stopping", { signal });

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    scheduler.stop();
    watcher.stop();

    // The queue drains on its own; the wait below is what bounds it.
    while (queue.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (queue.size > 0) {
      logger.warn("the queue did not drain before the deadline", { left: queue.size });
    }

    await proxy.stop().catch(() => undefined);
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

  /**
   * Runs a job that was found in the database.
   *
   * The payload is the update of Telegram as it came, so the bot handles it
   * the same way it handles a live one: the same middleware, the same
   * allowlist, the same pipeline. The job is marked as running first, so a
   * second start does not pick it up again, and its outcome is written back.
   */
  async function runRecoveredJob(job: { id: number; payload: string }): Promise<void> {
    const started = await inbox.start(job.id);
    if (!started) return;

    try {
      const update = JSON.parse(job.payload) as Parameters<typeof bot.handleUpdate>[0];
      await bot.handleUpdate(update);
      await inbox.succeed(job.id);
    } catch (error) {
      const result = await inbox.fail(job.id, String(error));
      logger.error("a recovered job failed", {
        jobId: job.id,
        retry: result.retry,
        error: String(error),
      });
    }
  }

  // The jobs that were running when the process stopped are put back into the
  // queue before anything else runs: the process that ran them is gone, and
  // nothing else will ever finish them. The pipeline reads the vault to decide
  // what actually happened, so a job whose write landed is reported as done
  // instead of being written twice.
  void inbox
    .recover()
    .then((recovered) => {
      for (const job of recovered) {
        void queue.push(() => runRecoveredJob(job));
      }
    })
    .catch((error) => {
      logger.error("could not recover the jobs of the previous run", { error: String(error) });
    });

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
 * The status line of a write, with the warning about the conflict copies of
 * Syncthing when there are any.
 *
 * A conflict copy is not an error of the write, so it does not replace the
 * status: it is added under it, where the owner cannot miss it.
 */
function statusWithConflicts(result: ProcessResult, language: Language): string {
  if (result.conflicts.length === 0) return result.status;
  const names = result.conflicts.join(", ");
  return `${result.status}\n\n${messages(language).conflictWarning(result.conflicts.length, names)}`;
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
  for (;;) {
    try {
      await bot.start({
        onStart: (info) => logger.info("the bot is polling Telegram", { username: info.username }),
        // The updates that arrived while the bot was down are handled, not
        // dropped: a message of the owner is not a stale event.
        drop_pending_updates: false,
      });
      return;
    } catch (error) {
      logger.error("the connection to telegram failed, trying again in 15 s", {
        error: String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 15_000));
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
 * How long a stop waits for the jobs that are already running.
 *
 * A write that is half done is worse than a slow stop, but a stop that never
 * ends is worse than both: Docker sends SIGKILL after its own timeout, and the
 * job would be lost without the recovery of the next start.
 */
const SHUTDOWN_GRACE_MS = 20_000;

/**
 * Writes a JSON answer once.
 *
 * A handler that answers and then fails in a later step must not write a
 * second time: the headers are already on the wire and the second write throws
 * inside the error path of the first. The socket may also be gone, because the
 * client hung up while the answer was being prepared.
 */
/**
 * The Telegram id of the person behind an update, when it carries one.
 *
 * It is only used for the log and for the retention of the jobs: the access is
 * decided by the middleware of the bot, not by this value.
 */
function readUserId(update: unknown): string | undefined {
  if (!update || typeof update !== "object") return undefined;
  const message = (update as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const from = (message as { from?: unknown }).from;
  if (!from || typeof from !== "object") return undefined;
  const id = (from as { id?: unknown }).id;
  return typeof id === "number" ? String(id) : undefined;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

/** Writes a plain answer once. */
function sendPlain(response: ServerResponse, status: number, text: string): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

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
