import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A02: a request target that is not a URL must not take the process down.
 *
 * The check runs against a real HTTP server on a loopback port, because the
 * problem lives in the parser of Node and in the first line of the handler:
 * `GET //% HTTP/1.1` is accepted by the parser and then rejected by
 * `new URL`, and an exception there used to leave the server.
 *
 * The handler below is the shape of the one in `src/index.ts`: the parsing is
 * inside the boundary, and every branch answers once.
 */

/** The shape of the boundary of the application. */
function boundary(
  handler: (url: URL) => { status: number; body: string },
): (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) => void {
  return (request, response) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        send(response, 400, "bad request");
        return;
      }
      const answer = handler(url);
      send(response, answer.status, answer.body);
    })().catch(() => {
      send(response, 500, "the server could not answer");
    });
  };
}

function send(response: import("node:http").ServerResponse, status: number, body: string): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

/** Starts the server on a free loopback port and gives the port. */
async function start(handler: (url: URL) => { status: number; body: string }): Promise<number> {
  server = createServer(boundary(handler));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** Sends raw bytes and gives the answer, or an empty string on a reset. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let answer = "";
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(answer);
    });
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      answer += chunk.toString("utf8");
    });
    socket.on("close", () => resolve(answer));
    socket.on("error", () => resolve(answer));
  });
}

/** A normal request over the same socket helper. */
function get(port: number, target: string): Promise<string> {
  return raw(port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
}

describe("A02: the http boundary of the application", () => {
  it("answers a bad request target with 400 and keeps serving", async () => {
    const port = await start((url) => ({ status: 200, body: `ok ${url.pathname}` }));

    const bad = await get(port, "//%");
    expect(bad).toContain("400");

    // The process is still there and answers the next request.
    const good = await get(port, "/health");
    expect(good).toContain("200");
    expect(good).toContain("ok /health");
  });

  it("survives a target that is only a percent sign", async () => {
    const port = await start(() => ({ status: 200, body: "ok" }));
    const answer = await get(port, "/%");
    expect(answer).toMatch(/^HTTP\/1\.1 (200|400)/);

    const next = await get(port, "/health");
    expect(next).toContain("200");
  });

  it("does not write a second answer when the handler fails after answering", async () => {
    let calls = 0;
    const port = await start(() => {
      calls += 1;
      // The handler answers, and the boundary then hits an error of its own.
      throw new Error("after the answer");
    });

    const answer = await get(port, "/health");
    expect(calls).toBe(1);
    // One status line only: a second writeHead would throw ERR_HTTP_HEADERS_SENT.
    expect(answer.match(/HTTP\/1\.1/g)?.length).toBe(1);
    expect(answer).toContain("500");
  });

  it("does not fall over when the client hangs up before the answer", async () => {
    const port = await start(() => ({ status: 200, body: "ok" }));

    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n");
        socket.destroy();
        resolve();
      });
      socket.on("error", () => resolve());
    });

    // The server is still alive for the next caller.
    const next = await get(port, "/health");
    expect(next).toContain("200");
  });
});
