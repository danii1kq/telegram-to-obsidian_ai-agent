import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { createMiniApp } from "../src/miniapp/api.js";
import { validateInitData } from "../src/miniapp/auth.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");
const BOT_TOKEN = "123456:test-token";

/** Signs the data of the Mini App the way Telegram does. */
function signInitData(params: Record<string, string>, botToken = BOT_TOKEN): string {
  const dataCheckString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

function fakeRequest(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
  body = "",
): IncomingMessage {
  return {
    url,
    headers,
    method,
    socket: {},
    on: (event: string, callback: (...args: unknown[]) => void) => {
      if (event === "data" && body) callback(Buffer.from(body));
      if (event === "end") callback();
    },
  } as unknown as IncomingMessage;
}

function fakeResponse() {
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      response.headers[name] = value;
      return response;
    },
    writeHead(status: number, headers: Record<string, string>) {
      response.statusCode = status;
      response.headers = { ...response.headers, ...headers };
      return response;
    },
    end(body?: Buffer | string) {
      if (body) chunks.push(Buffer.from(body));
      return response;
    },
    body: () => Buffer.concat(chunks).toString("utf8"),
  };
  return response as unknown as ServerResponse & {
    body: () => string;
    headers: Record<string, string>;
  };
}

async function makeMiniApp() {
  const root = await mkdtemp(path.join(tmpdir(), "miniapp-"));
  const guard = new VaultGuard({
    vaultRoot: path.join(root, "vault"),
    settleDelayMs: 1,
    verifyDelayMs: 1,
  });
  const vault = new VaultOperations({
    guard,
    eventsFile: path.join(root, "events.json"),
    timeZone: "Asia/Almaty",
    logger,
  });
  await vault.writeNote("Ideas.md", "an idea for the business");

  const handle = createMiniApp({
    vault,
    botToken: BOT_TOKEN,
    browserToken: "secret-token",
    logger,
    webRoot: path.join(root, "web"),
  });

  return { handle, root, vault };
}

describe("validateInitData", () => {
  it("takes the signed data of Telegram", () => {
    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "abc",
      user: JSON.stringify({ id: 42, first_name: "Daniil" }),
    });
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.user?.id).toBe(42);
  });

  it("does not take the data with a wrong signature", () => {
    const initData = signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "abc" },
      "another-token",
    );
    expect(validateInitData(initData, BOT_TOKEN).ok).toBe(false);
  });

  it("does not take the old data", () => {
    const initData = signInitData({ auth_date: "1000000000", query_id: "abc" });
    expect(validateInitData(initData, BOT_TOKEN).ok).toBe(false);
  });

  it("does not take the empty data", () => {
    expect(validateInitData("", BOT_TOKEN).ok).toBe(false);
  });
});

describe("the static files of the mini app", () => {
  it("gives the page and the assets of the build", async () => {
    const { handle, root } = await makeMiniApp();
    const webRoot = path.join(root, "web");
    await mkdir(path.join(webRoot, "assets"), { recursive: true });
    await writeFile(
      path.join(webRoot, "index.html"),
      '<script src="./assets/index-abc.js"></script>',
      "utf8",
    );
    await writeFile(path.join(webRoot, "assets", "index-abc.js"), "console.log(1)", "utf8");

    const page = fakeResponse();
    await handle(fakeRequest("/"), page);
    expect(page.statusCode).toBe(200);
    expect(page.body()).toContain("assets/index-abc.js");

    // The paths of the assets are relative, so they are asked for from the root.
    const asset = fakeResponse();
    await handle(fakeRequest("/assets/index-abc.js"), asset);
    expect(asset.statusCode).toBe(200);
    expect(asset.body()).toBe("console.log(1)");
  });

  it("does not go out of the folder of the frontend", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/../../etc/passwd"), response);
    // The path is normalized and the file is not in the folder of the
    // frontend, so it is never given away.
    expect(response.statusCode).not.toBe(200);
    expect(response.body()).not.toContain("root:");
  });
});

describe("the safety of the mini app", () => {
  it("sets the security headers on every answer", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/"), response);

    expect(response.headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(response.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(response.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("exchanges the token of the owner for a session", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(
      fakeRequest("/api/session", {}, "POST", JSON.stringify({ token: "secret-token" })),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers["Set-Cookie"]).toContain("vault_session=");
    expect(response.headers["Set-Cookie"]).toContain("HttpOnly");
    expect(response.headers["Set-Cookie"]).toContain("SameSite=Strict");
  });

  it("does not open a session with a wrong token", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(
      fakeRequest("/api/session", {}, "POST", JSON.stringify({ token: "wrong" })),
      response,
    );
    expect(response.statusCode).toBe(401);
  });

  it("never gives a file of the owner as a page", async () => {
    const { handle, root } = await makeMiniApp();
    await mkdir(path.join(root, "vault", "attachments"), { recursive: true });
    await writeFile(
      path.join(root, "vault", "attachments", "page.html"),
      "<script>alert(1)</script>",
      "utf8",
    );

    const response = fakeResponse();
    await handle(fakeRequest("/api/file?path=attachments/page.html&token=secret-token"), response);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("the api of the mini app", () => {
  it("does not answer a request without the data of Telegram", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes"), response);
    expect(response.statusCode).toBe(401);
  });

  it("answers a request with the data of Telegram", async () => {
    const { handle } = await makeMiniApp();
    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "abc",
    });
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes", { "x-telegram-init-data": initData }), response);

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body()) as { notes: { title: string }[] };
    expect(payload.notes[0]?.title).toBe("Ideas");
  });

  it("answers a request with the token of the owner", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes?token=secret-token"), response);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body()).notes).toHaveLength(1);
  });

  it("searches the notes", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/api/search?q=business&token=secret-token"), response);

    const payload = JSON.parse(response.body()) as { hits: { title: string }[] };
    expect(payload.hits[0]?.title).toBe("Ideas");
  });

  it("opens a note", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/api/note?path=Ideas.md&token=secret-token"), response);

    const payload = JSON.parse(response.body()) as { note: { content: string } };
    expect(payload.note.content).toContain("an idea");
  });

  it("opens a session for the data of telegram, so a picture can be asked for", async () => {
    const { handle } = await makeMiniApp();
    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "AAE_test",
    });
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes", { "x-telegram-init-data": initData }), response);

    expect(response.statusCode).toBe(200);
    const cookie = response.headers["Set-Cookie"] ?? "";
    expect(cookie).toContain("vault_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("gives the notes with the path, the app works with it", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes?token=secret-token"), response);

    const payload = JSON.parse(response.body()) as {
      notes: Array<{ path: string; title: string; date: string; tags: string[] }>;
    };
    expect(payload.notes[0]?.path).toBe("Ideas.md");
    expect(payload.notes[0]?.title).toBe("Ideas");
    expect(Array.isArray(payload.notes[0]?.tags)).toBe(true);
  });

  it("pages the notes and says when there are more", async () => {
    const { handle, vault } = await makeMiniApp();
    // The first note is already there, a few more make a second page.
    for (let index = 2; index <= 5; index += 1) {
      await vault.writeNote(`Note ${index}.md`, `the note number ${index}`);
    }

    const first = fakeResponse();
    await handle(fakeRequest("/api/notes?limit=2&offset=0&token=secret-token"), first);
    const firstPage = JSON.parse(first.body()) as {
      notes: Array<{ path: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(firstPage.notes).toHaveLength(2);
    expect(firstPage.total).toBe(5);
    expect(firstPage.hasMore).toBe(true);

    const last = fakeResponse();
    await handle(fakeRequest("/api/notes?limit=2&offset=4&token=secret-token"), last);
    const lastPage = JSON.parse(last.body()) as {
      notes: Array<{ path: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(lastPage.notes).toHaveLength(1);
    expect(lastPage.hasMore).toBe(false);
  });
});
