import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { createMiniApp } from "../src/miniapp/api.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");
const BOT_TOKEN = "123456:test-token";
const OWNER_ID = 42;
const STRANGER_ID = 1337;

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

/** Valid signed data for a user, the way a real client would send it. */
function initDataFor(userId: number | null): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAE_test",
  };
  if (userId !== null) {
    params.user = JSON.stringify({ id: userId, first_name: "Test" });
  }
  return signInitData(params);
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

async function makeMiniApp(overrides: { allowedUserIds?: Set<number> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "miniapp-auth-"));
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
  await vault.writeNote("Private.md", "a private thought of the owner");

  const handle = createMiniApp({
    vault,
    botToken: BOT_TOKEN,
    browserToken: "owner-token",
    logger,
    webRoot: path.join(root, "web"),
    allowedUserIds: overrides.allowedUserIds ?? new Set([OWNER_ID]),
    ownerId: OWNER_ID,
  });

  return { handle, root, vault };
}

/** The private endpoints, all of which must refuse a stranger. */
const PRIVATE_ENDPOINTS = [
  "/api/notes",
  "/api/note?path=Private.md",
  "/api/search?q=private",
  "/api/summaries",
  "/api/config",
  "/api/file?path=Private.md",
];

describe("A01: a signed user that is not in the allowlist", () => {
  for (const endpoint of PRIVATE_ENDPOINTS) {
    it(`refuses ${endpoint} for a stranger with valid signed data`, async () => {
      const { handle } = await makeMiniApp();
      const response = fakeResponse();
      await handle(
        fakeRequest(endpoint, { "x-telegram-init-data": initDataFor(STRANGER_ID) }),
        response,
      );

      expect(response.statusCode).toBe(401);
      expect(response.body()).not.toContain("private thought");
    });
  }

  it("refuses signed data that carries no user at all", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(
      fakeRequest("/api/notes", { "x-telegram-init-data": initDataFor(null) }),
      response,
    );

    expect(response.statusCode).toBe(401);
  });

  it("refuses signed data with a user that has no numeric id", async () => {
    const { handle } = await makeMiniApp();
    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "AAE_test",
      user: JSON.stringify({ first_name: "No Id" }),
    });
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes", { "x-telegram-init-data": initData }), response);

    expect(response.statusCode).toBe(401);
  });

  it("refuses signed data whose user is not an object", async () => {
    const { handle } = await makeMiniApp();
    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "AAE_test",
      user: "42",
    });
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes", { "x-telegram-init-data": initData }), response);

    expect(response.statusCode).toBe(401);
  });

  it("still answers the owner with valid signed data", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(
      fakeRequest("/api/notes", { "x-telegram-init-data": initDataFor(OWNER_ID) }),
      response,
    );

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body()) as { notes: Array<{ title: string }> };
    expect(payload.notes[0]?.title).toBe("Private");
  });

  it("still answers the owner through the browser token", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes", { "x-auth-token": "owner-token" }), response);

    expect(response.statusCode).toBe(200);
  });
});

describe("A13: the life of the session of the mini app", () => {
  it("reuses the session of the cookie instead of making a new one every request", async () => {
    const { handle } = await makeMiniApp();
    const first = fakeResponse();
    await handle(
      fakeRequest("/api/notes", { "x-telegram-init-data": initDataFor(OWNER_ID) }),
      first,
    );
    const cookie = first.headers["Set-Cookie"] ?? "";
    expect(cookie).toContain("vault_session=");
    const session = cookie.split(";")[0] ?? "";

    // The next request carries the cookie and no signed data: the session is
    // enough, and no new cookie is handed out.
    const second = fakeResponse();
    await handle(fakeRequest("/api/notes", { cookie: session }), second);
    expect(second.statusCode).toBe(200);
    expect(second.headers["Set-Cookie"]).toBeUndefined();

    // The same session keeps working for the next request as well.
    const third = fakeResponse();
    await handle(fakeRequest("/api/note?path=Private.md", { cookie: session }), third);
    expect(third.statusCode).toBe(200);
  });

  it("checks the allowlist again when a session is used", async () => {
    // A session is only opened for an allowed user, so the check is the same
    // one: a session that belongs to nobody in the allowlist is not honoured.
    const { handle } = await makeMiniApp({ allowedUserIds: new Set([999]) });
    const response = fakeResponse();
    await handle(
      fakeRequest("/api/notes", { "x-telegram-init-data": initDataFor(OWNER_ID) }),
      response,
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers["Set-Cookie"]).toBeUndefined();
  });

  it("does not honour a session that was never handed out", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes", { cookie: "vault_session=deadbeef" }), response);

    expect(response.statusCode).toBe(401);
  });

  it("does not open a session for a stranger", async () => {
    const { handle } = await makeMiniApp();
    const response = fakeResponse();
    await handle(
      fakeRequest("/api/session", {}, "POST", JSON.stringify({ token: "owner-token" })),
      response,
    );
    expect(response.statusCode).toBe(200);
  });

  it("limits the number of the requests of the expensive endpoints", async () => {
    const { handle } = await makeMiniApp();
    let refused = 0;
    for (let index = 0; index < 40; index += 1) {
      const response = fakeResponse();
      await handle(
        fakeRequest("/api/search?q=private", { "x-auth-token": "owner-token" }),
        response,
      );
      if (response.statusCode === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("does not write the signed data into the debug file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "miniapp-debug-"));
    const debugFile = path.join(root, "debug.txt");
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
    const handle = createMiniApp({
      vault,
      botToken: BOT_TOKEN,
      browserToken: "owner-token",
      logger,
      webRoot: path.join(root, "web"),
      allowedUserIds: new Set([OWNER_ID]),
      ownerId: OWNER_ID,
      debugFile,
    });

    // Signed data with a bad signature: it is exactly the case that used to be
    // written to the file, together with the user of the data.
    const initData = "auth_date=1&user=%7B%22id%22%3A42%7D&hash=00";
    const response = fakeResponse();
    await handle(fakeRequest("/api/notes", { "x-telegram-init-data": initData }), response);
    expect(response.statusCode).toBe(401);

    // The reason and the names of the fields are useful; the data itself
    // carries the identity of the person and the hash, and it is not kept.
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(debugFile, "utf8");
    expect(written).not.toContain("hash=00");
    expect(written).not.toContain(initData);
    expect(written).not.toContain("%7B%22id%22");
    expect(written).toContain("fields=");
  });
});
