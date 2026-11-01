import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
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
  /** The summaries of the days, they are shown at the top of the list. */
  summaries?: () => Promise<SummaryEntry[]>;
  /** The file for the data that was not accepted, for the diagnostics. */
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

/**
 * The Mini App of the notes.
 *
 * The frontend is a static build that lives in the image, the data comes from
 * the vault through a small API. Every request is checked: the Mini App sends
 * the signed data of Telegram, the browser sends the token of the owner.
 */
export function createMiniApp(options: MiniAppOptions) {
  const { vault, botToken, browserToken, logger, webRoot } = options;

  /**
   * The sessions of the Mini App.
   *
   * The data of Telegram comes in a header, but a picture in a note is asked
   * for by the browser itself, and a picture cannot carry a header. So the
   * first request with the signed data opens a session, and the session
   * lives in a cookie.
   */
  const sessions = new Map<string, number>();
  const sessionCookie = "vault_session";
  const sessionLifetime = 86_400_000;

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

      const auth = await authorize(request, url);
      if (!auth.ok) {
        logger.warn("a request to the mini app was not allowed", { path: pathname });
        sendJson(response, 401, { ok: false, error: "not allowed" });
        return true;
      }
      if (auth.session) {
        response.setHeader("Set-Cookie", sessionCookieHeader(auth.session, isSecure(request)));
      }
      await handleApi(request, response, url, pathname);
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
   * access.
   */
  async function handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBody(request);
      const token = parseToken(body);
      if (!token || !browserToken || token !== browserToken) {
        sendJson(response, 401, { ok: false, error: "not allowed" });
        return;
      }
      const session = randomBytes(24).toString("hex");
      sessions.set(session, Date.now() + sessionLifetime);
      pruneSessions();
      response.setHeader("Set-Cookie", sessionCookieHeader(session, isSecure(request)));
      sendJson(response, 200, { ok: true });
    } catch (error) {
      logger.error("the session could not be opened", { error: String(error) });
      sendJson(response, 400, { ok: false, error: "bad request" });
    }
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

  /**
   * Checks the request: the signed data of Telegram, the session of the
   * Mini App or the token of the owner.
   */
  async function authorize(
    request: IncomingMessage,
    url: URL,
  ): Promise<{ ok: boolean; userId?: number; session?: string }> {
    const initData = request.headers["x-telegram-init-data"];
    if (typeof initData === "string" && initData.length > 0) {
      const result = validateInitData(initData, botToken);
      if (!result.ok) {
        logger.warn("the init data of telegram was not accepted", {
          reason: result.error,
          length: initData.length,
          fields: [...new URLSearchParams(initData).keys()],
        });
        void saveDebug(initData);
        return { ok: false };
      }

      const session = randomBytes(24).toString("hex");
      sessions.set(session, Date.now() + sessionLifetime);
      pruneSessions();
      return { ok: true, userId: result.user?.id, session };
    }

    // The session of the Mini App, it is in the cookie.
    const cookies = request.headers.cookie ?? "";
    for (const part of cookies.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name !== sessionCookie || !value) continue;
      const expiry = sessions.get(value);
      if (expiry && expiry > Date.now()) {
        return { ok: true };
      }
      sessions.delete(value);
    }

    const header = request.headers["x-auth-token"];
    const token = typeof header === "string" ? header : url.searchParams.get("token");
    if (token && browserToken && token === browserToken) return { ok: true };

    logger.warn("a request to the mini app came without the data of telegram", {
      path: url.pathname,
    });
    return { ok: false };
  }

  /** Throws away the sessions that are over and keeps the list short. */
  function pruneSessions(): void {
    const now = Date.now();
    for (const [session, expiry] of sessions) {
      if (expiry <= now) sessions.delete(session);
    }
    while (sessions.size > 50) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    pathname: string,
  ): Promise<void> {
    try {
      if (pathname === "/api/config") {
        const userId = await currentUserId(request, url);
        const language = userId
          ? ((await options.language?.(userId)) ?? options.defaultLanguage ?? "en")
          : (options.defaultLanguage ?? "en");
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
        // The whole vault is listed to know whether there is a next page, and
        // only the asked window is read from the disk.
        const all = await vault.listNotes();
        const page = await vault.listNotesDetailed(offset + limit);
        const window = page.slice(offset);
        // The app works with the path of the note, the name of the file is a
        // detail of the vault.
        sendJson(response, 200, {
          ok: true,
          notes: window.map((note) => ({
            path: note.relativePath,
            title: note.title,
            date: note.date,
            tags: note.tags,
            snippet: note.snippet,
            size: note.size,
            mtimeMs: note.mtimeMs,
          })),
          total: all.length,
          hasMore: offset + window.length < all.length,
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
   * The user behind the request: the signed data of Telegram carries the id,
   * the browser of the owner is the owner itself.
   */
  async function currentUserId(request: IncomingMessage, url: URL): Promise<number | undefined> {
    const initData = request.headers["x-telegram-init-data"];
    if (typeof initData === "string" && initData.length > 0) {
      const result = validateInitData(initData, botToken);
      return result.ok ? result.user?.id : undefined;
    }

    const header = request.headers["x-auth-token"];
    const token = typeof header === "string" ? header : url.searchParams.get("token");
    if (token && browserToken && token === browserToken) return options.ownerId;
    return undefined;
  }

  /**
   * Keeps the last rejected data of Telegram in a file, so the problem can be
   * looked at. The file is only written when the path is set.
   */
  async function saveDebug(initData: string): Promise<void> {
    if (!options.debugFile) return;
    try {
      await writeFile(options.debugFile, initData, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      logger.warn("could not write the debug file", { error: String(error) });
    }
  }

  async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const root = path.resolve(webRoot);
    const relative = pathname
      .replace(/^\/app\//, "")
      .replace(/^\//, "")
      .trim();
    const target = path.resolve(root, relative === "" ? "index.html" : relative);
    const inside = path.relative(root, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
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

    const body = await readFile(target);
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    response.end(body);
  }
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
