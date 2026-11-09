import { randomBytes } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Language } from "../i18n/index.js";
import type { Logger } from "../logger.js";
import type { VaultOperations } from "../vault/operations.js";
import { validateInitData } from "./auth.js";

export interface SummaryEntry {
  /** The day of the summary, `2026-10-21`. */
  date: string;
  /** The text of the summary. */
  summary: string;
  /** The file of the month with the summary. */
  file: string;
}

export interface MiniAppOptions {
  vault: VaultOperations;
  botToken: string;
  /** The token for the browser: there is no init data outside of Telegram. */
  browserToken: string;
  logger: Logger;
  /** The folder with the built frontend. */
  webRoot: string;
  /**
   * The Telegram user ids that may read the vault.
   *
   * The signature of the init data proves where the data came from, not that
   * the person behind it is the owner: anybody who opens the Mini App gets a
   * valid signature for their own account. Without this list every such user
   * would read the notes, so a missing list allows nobody.
   */
  allowedUserIds: ReadonlySet<number>;
  /** The summaries of the days, they are shown at the top of the list. */
  summaries?: () => Promise<SummaryEntry[]>;
  /** The file for the diagnostics of the data that was not accepted. */
  debugFile?: string;
  /** The name of the bot, for the button that opens the chat with it. */
  botUsername?: () => string;
  /** The language of a user, for the texts of the app. */
  language?: (userId: number) => Promise<Language>;
  /** The language of the app when there is no user behind the request. */
  defaultLanguage?: Language;
  /** The id of the owner, for the requests from the browser. */
  ownerId?: number;
}

/**
 * Who is behind a request, and on what grounds.
 *
 * Every private route works from this value only: the identity, the reason it
 * is trusted and the moment the trust ends. A route never re-reads the headers
 * to find out who the caller is, so there is one place where the access is
 * decided.
 */
export interface AuthContext {
  /** The Telegram id of the person behind the request. */
  userId: number;
  /** How the caller proved the identity. */
  basis: "telegram" | "session" | "browser-token";
  /** When the access ends, in epoch milliseconds. */
  expiresAt: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** The files of the owner that the app shows as a picture. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * The headers of every answer of the app.
 *
 * The content security policy keeps the scripts of the page to the app itself
 * and to the SDK of Telegram. The referrer policy stops the address of the
 * page (with the token of the owner in it) from travelling to other sites.
 * The frames are allowed for the clients of Telegram, they are the only ones
 * that show the app.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

/** How long a session of the Mini App lives. */
const SESSION_LIFETIME_MS = 86_400_000;
/** The most sessions that are kept at once. */
const MAX_SESSIONS = 50;
/** The most sessions one user may hold, so one client cannot push out the rest. */
const MAX_SESSIONS_PER_USER = 5;

/**
 * How many requests an endpoint takes per window.
 *
 * A search reads the whole vault, so it is the expensive one and it is limited
 * the hardest. A picture is asked for by the browser itself and a note with a
 * hundred pictures makes a hundred requests, so that limit is generous.
 */
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  "/api/search": { limit: 30, windowMs: 60_000 },
  "/api/notes": { limit: 120, windowMs: 60_000 },
  "/api/note": { limit: 120, windowMs: 60_000 },
  "/api/file": { limit: 600, windowMs: 60_000 },
  "/api/summaries": { limit: 120, windowMs: 60_000 },
  "/api/config": { limit: 120, windowMs: 60_000 },
};

interface Session {
  userId: number;
  basis: "telegram" | "browser-token";
  expiresAt: number;
}

/**
 * The Mini App of the notes.
 *
 * The frontend is a static build that lives in the image, the data comes from
 * the vault through a small API. Every request is checked: the Mini App sends
 * the signed data of Telegram, the browser sends the token of the owner.
 */
export function createMiniApp(options: MiniAppOptions) {
  const { vault, botToken, browserToken, logger, webRoot } = options;
  const allowedUserIds = options.allowedUserIds;

  /**
   * The sessions of the Mini App.
   *
   * The data of Telegram comes in a header, but a picture in a note is asked
   * for by the browser itself, and a picture cannot carry a header. So the
   * first request with the signed data opens a session, and the session lives
   * in a cookie. The session carries the identity, so a request that comes
   * with the cookie alone is answered for the same user.
   */
  const sessions = new Map<string, Session>();
  const sessionCookie = "vault_session";

  /** The moments of the recent requests of every endpoint and user. */
  const rateWindows = new Map<string, number[]>();

  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      // The token of the owner is exchanged for a session here, so this is
      // the one endpoint that does not need the access.
      if (pathname === "/api/session" && request.method === "POST") {
        await handleSession(request, response);
        return true;
      }

      const auth = await authorize(request);
      if (!auth.ok) {
        logger.warn("a request to the mini app was not allowed", {
          path: pathname,
          reason: auth.reason,
        });
        sendJson(response, 401, { ok: false, error: "not allowed" });
        return true;
      }
      if (auth.setCookie) {
        response.setHeader("Set-Cookie", auth.setCookie);
      }
      if (!withinRateLimit(auth.auth, pathname)) {
        logger.warn("a request to the mini app was over its rate", {
          path: pathname,
          userId: auth.auth.userId,
        });
        response.setHeader("Retry-After", "60");
        sendJson(response, 429, { ok: false, error: "too many requests" });
        return true;
      }
      await handleApi(request, response, url, pathname, auth.auth);
      return true;
    }

    // Everything else belongs to the frontend: the page itself and the assets
    // of the build. The paths of the assets are relative, so they are asked
    // for from the root of the app.
    await serveStatic(response, pathname);
    return true;
  };

  /**
   * Exchanges the token of the owner for a session.
   *
   * The token is in the address of the page, so it is given to the server
   * once and taken out of the address: from then on the cookie carries the
   * access. The session remembers the owner, so the settings of the owner are
   * the same as in the chat.
   */
  async function handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBody(request);
      const token = parseToken(body);
      if (!token || !browserToken || token !== browserToken) {
        sendJson(response, 401, { ok: false, error: "not allowed" });
        return;
      }
      const userId = options.ownerId;
      if (userId === undefined || !allowedUserIds.has(userId)) {
        logger.warn("the browser token has no owner in the allowlist");
        sendJson(response, 401, { ok: false, error: "not allowed" });
        return;
      }

      // The session of the cookie is reused when it is still good: the page
      // asks for the exchange on every load, and a new session on every load
      // would push the sessions of the other devices out.
      const existing = readSessionToken(request);
      const session = existing ? sessions.get(existing) : undefined;
      if (existing && session && session.userId === userId && session.expiresAt > Date.now()) {
        sendJson(response, 200, { ok: true });
        return;
      }

      const opened = openSession(userId, "browser-token");
      response.setHeader("Set-Cookie", sessionCookieHeader(opened, isSecure(request)));
      sendJson(response, 200, { ok: true });
    } catch (error) {
      logger.error("the session could not be opened", { error: String(error) });
      sendJson(response, 400, { ok: false, error: "bad request" });
    }
  }

  /** Opens a session for a user and keeps it. */
  function openSession(userId: number, basis: Session["basis"]): string {
    const token = randomBytes(24).toString("hex");
    sessions.set(token, { userId, basis, expiresAt: Date.now() + SESSION_LIFETIME_MS });
    pruneSessions(userId);
    return token;
  }

  /** The cookie of the session, with the flags of a session cookie. */
  function sessionCookieHeader(session: string, secure: boolean): string {
    const parts = [
      `${sessionCookie}=${session}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=86400",
    ];
    if (secure) parts.push("Secure");
    return parts.join("; ");
  }

  /** True when the request came over https, the tunnel sets the header. */
  function isSecure(request: IncomingMessage): boolean {
    const proto = request.headers["x-forwarded-proto"];
    const value = Array.isArray(proto) ? proto[0] : proto;
    const socket = request.socket as { encrypted?: boolean } | undefined;
    return value === "https" || Boolean(socket?.encrypted);
  }

  /** The session token of the cookie of the request. */
  function readSessionToken(request: IncomingMessage): string | null {
    const cookies = request.headers.cookie ?? "";
    for (const part of cookies.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === sessionCookie && value) return value;
    }
    return null;
  }

  /**
   * Checks the request and says who is behind it.
   *
   * The order is the signed data of Telegram, then the session of the cookie,
   * then the token of the owner. Every path ends in the same AuthContext, and
   * the allowlist is checked on every one of them: a signature proves the data
   * came from Telegram, not that the person may read the notes.
   */
  async function authorize(
    request: IncomingMessage,
  ): Promise<{ ok: true; auth: AuthContext; setCookie?: string } | { ok: false; reason: string }> {
    const initData = request.headers["x-telegram-init-data"];
    if (typeof initData === "string" && initData.length > 0) {
      const result = validateInitData(initData, botToken);
      if (!result.ok) {
        logger.warn("the init data of telegram was not accepted", {
          reason: result.error,
          length: initData.length,
          fields: [...new URLSearchParams(initData).keys()],
        });
        await saveDebug(result.error ?? "the init data was not accepted", initData);
        return { ok: false, reason: "the init data was not accepted" };
      }

      const userId = result.user?.id;
      if (typeof userId !== "number" || !Number.isInteger(userId)) {
        logger.warn("the init data of telegram carries no user");
        await saveDebug("the init data carries no user", initData);
        return { ok: false, reason: "no user in the init data" };
      }
      if (!allowedUserIds.has(userId)) {
        // The signature is good, the person is not the owner. This is the
        // check that keeps a stranger out of the notes.
        logger.warn("a user that is not allowed opened the mini app", { userId });
        return { ok: false, reason: "the user is not allowed" };
      }

      // The page asks for the data on every load, so the session of the
      // cookie is reused when it belongs to the same user. A new session on
      // every request would fill the store and push the other devices out.
      const existing = readSessionToken(request);
      const session = existing ? sessions.get(existing) : undefined;
      if (existing && session && session.userId === userId && session.expiresAt > Date.now()) {
        return {
          ok: true,
          auth: { userId, basis: "session", expiresAt: session.expiresAt },
        };
      }

      const opened = openSession(userId, "telegram");
      return {
        ok: true,
        auth: { userId, basis: "telegram", expiresAt: Date.now() + SESSION_LIFETIME_MS },
        setCookie: sessionCookieHeader(opened, isSecure(request)),
      };
    }

    // The session of the Mini App, it is in the cookie.
    const token = readSessionToken(request);
    if (token) {
      const session = sessions.get(token);
      if (session && session.expiresAt > Date.now()) {
        // The allowlist is checked again: a session outlives the change of the
        // list, and a user that was removed from it must lose the access.
        if (!allowedUserIds.has(session.userId)) {
          sessions.delete(token);
          logger.warn("a session of a user that is no longer allowed was dropped", {
            userId: session.userId,
          });
          return { ok: false, reason: "the user is not allowed" };
        }
        return {
          ok: true,
          auth: {
            userId: session.userId,
            basis: "session",
            expiresAt: session.expiresAt,
          },
        };
      }
      sessions.delete(token);
    }

    const header = request.headers["x-auth-token"];
    if (typeof header === "string" && header.length > 0) {
      if (browserToken && header === browserToken) {
        const userId = options.ownerId;
        if (userId === undefined || !allowedUserIds.has(userId)) {
          return { ok: false, reason: "the browser token has no owner" };
        }
        return {
          ok: true,
          auth: { userId, basis: "browser-token", expiresAt: Date.now() + SESSION_LIFETIME_MS },
        };
      }
      return { ok: false, reason: "the token of the owner does not match" };
    }

    // The token is not read from the address of the page: an address ends up
    // in the history of the browser, in the log of the proxy and in the
    // referrer of every request, so the token travels in a header only and is
    // exchanged for a session on the first load.
    logger.warn("a request to the mini app came without the data of telegram");
    return { ok: false, reason: "no credentials" };
  }

  /** Throws away the sessions that are over and keeps the list short. */
  function pruneSessions(userId?: number): void {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }

    // One user may hold a few sessions, not all of them.
    if (userId !== undefined) {
      const own = [...sessions].filter(([, session]) => session.userId === userId);
      for (const [token] of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_USER))) {
        sessions.delete(token);
      }
    }

    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  }

  /**
   * Says whether the request is under the limit of its endpoint.
   *
   * The window is per user and per endpoint, so a burst of pictures does not
   * use up the search of the owner. The counters live in the process: one
   * instance serves the app, so there is nothing to share them with.
   */
  function withinRateLimit(auth: AuthContext, pathname: string): boolean {
    const rule = RATE_LIMITS[pathname];
    if (!rule) return true;

    const key = `${auth.userId}:${pathname}`;
    const now = Date.now();
    const recent = (rateWindows.get(key) ?? []).filter((at) => now - at < rule.windowMs);
    if (recent.length >= rule.limit) {
      rateWindows.set(key, recent);
      return false;
    }
    recent.push(now);
    rateWindows.set(key, recent);
    return true;
  }

  async function handleApi(
    _request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    pathname: string,
    auth: AuthContext,
  ): Promise<void> {
    try {
      if (pathname === "/api/config") {
        const language = (await options.language?.(auth.userId)) ?? options.defaultLanguage ?? "en";
        sendJson(response, 200, {
          ok: true,
          botUsername: options.botUsername?.() ?? "",
          language,
        });
        return;
      }

      if (pathname === "/api/summaries") {
        const entries = options.summaries ? await options.summaries() : [];
        sendJson(response, 200, { ok: true, summaries: entries });
        return;
      }

      if (pathname === "/api/notes") {
        const limit = clamp(Number(url.searchParams.get("limit") ?? 60), 1, 200);
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        // One snapshot of the listing, and only the asked window is read from
        // the disk: the page number does not change the cost of a page.
        const page = await vault.listNotesWindow({ offset, limit });
        // The app works with the path of the note, the name of the file is a
        // detail of the vault.
        sendJson(response, 200, {
          ok: true,
          notes: page.notes.map((note) => ({
            path: note.relativePath,
            title: note.title,
            date: note.date,
            tags: note.tags,
            snippet: note.snippet,
            size: note.size,
            mtimeMs: note.mtimeMs,
          })),
          total: page.total,
          hasMore: page.hasMore,
        });
        return;
      }

      if (pathname === "/api/note") {
        const target = url.searchParams.get("path") ?? "";
        if (!target) {
          sendJson(response, 400, { ok: false, error: "no path" });
          return;
        }
        const file = await vault.readFile(target);
        sendJson(response, 200, {
          ok: true,
          note: {
            path: file.relativePath,
            content: file.content,
            bytes: Buffer.byteLength(file.content, "utf8"),
          },
        });
        return;
      }

      if (pathname === "/api/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) {
          sendJson(response, 200, { ok: true, hits: [] });
          return;
        }
        const byName = await vault.searchFiles({ target: "files", pattern: query });
        const byContent = await vault.searchFiles({ target: "content", pattern: query });
        const seen = new Set<string>();
        const hits = [];
        for (const hit of [...byName, ...byContent]) {
          if (seen.has(hit.relativePath)) continue;
          seen.add(hit.relativePath);
          hits.push({
            path: hit.relativePath,
            title: hit.title,
            line: hit.line ?? null,
            snippet: hit.snippet ?? "",
          });
          if (hits.length >= 40) break;
        }
        sendJson(response, 200, { ok: true, hits });
        return;
      }

      if (pathname === "/api/file") {
        const target = url.searchParams.get("path") ?? "";
        const file = await vault.readBinary(target).catch(() => null);
        if (!file) {
          sendJson(response, 404, { ok: false, error: "no file" });
          return;
        }

        // A file of the owner is never a page: only the pictures are shown as
        // pictures, everything else comes as a download. Otherwise a file with
        // the html inside would run in the origin of the app.
        const guessed = CONTENT_TYPES[path.extname(file.relativePath).toLowerCase()];
        const type = guessed && IMAGE_TYPES.has(guessed) ? guessed : "application/octet-stream";
        const disposition = type === "application/octet-stream" ? "attachment" : "inline";
        response.writeHead(200, {
          "content-type": type,
          "content-disposition": `${disposition}; filename="${encodeURIComponent(path.basename(file.relativePath))}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=300",
        });
        response.end(Buffer.from(file.data));
        return;
      }

      sendJson(response, 404, { ok: false, error: "unknown endpoint" });
    } catch (error) {
      logger.error("the mini app api failed", { path: pathname, error: String(error) });
      sendJson(response, 500, { ok: false, error: "the server could not answer" });
    }
  }

  /**
   * Keeps a note about the data of Telegram that was not accepted.
   *
   * The data itself is never written: it carries the identity of the person
   * and the hash of the signature, and a diagnostic file is not a place for
   * either of them. Only the reason and the names of the fields are kept.
   */
  async function saveDebug(reason: string, initData: string): Promise<void> {
    if (!options.debugFile) return;
    try {
      const fields = [...new URLSearchParams(initData).keys()].join(",");
      await writeFile(
        options.debugFile,
        `${new Date().toISOString()} ${reason} fields=${fields}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    } catch (error) {
      logger.warn("could not write the debug file", { error: String(error) });
    }
  }

  async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const root = await realpath(path.resolve(webRoot)).catch(() => path.resolve(webRoot));
    const relative = pathname
      .replace(/^\/app\//, "")
      .replace(/^\//, "")
      .trim();
    const target = path.resolve(root, relative === "" ? "index.html" : relative);
    if (!insideRoot(root, target)) {
      sendJson(response, 403, { ok: false, error: "forbidden" });
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      // A missing file with an extension is a missing file, not a page.
      if (path.extname(relative) !== "") {
        sendJson(response, 404, { ok: false, error: "not found" });
        return;
      }
      // The Mini App is a single page, every unknown path leads to it.
      const index = path.resolve(root, "index.html");
      const html = await readFile(index).catch(() => null);
      if (!html) {
        sendJson(response, 404, { ok: false, error: "the mini app is not built" });
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    // A link inside the build must not lead outside of it.
    const real = await realpath(target).catch(() => null);
    if (!real || !insideRoot(root, real)) {
      sendJson(response, 403, { ok: false, error: "forbidden" });
      return;
    }

    const body = await readFile(real);
    const type = CONTENT_TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    response.end(body);
  }
}

/** True when the path is the root itself or sits below it. */
function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

/** The body of a request, with a limit so a big body cannot fill the memory. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  return new Promise((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error("the body is too big"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** The token of the owner from the body of the request. */
function parseToken(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
