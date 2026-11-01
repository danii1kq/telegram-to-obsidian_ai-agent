import http from "node:http";
import { describe, expect, it } from "vitest";
import { Transcriber } from "../src/llm/transcribe.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("error", "test");

/** A model that answers with whatever the test wants. */
async function fakeModel(answer: unknown, status = 200) {
  const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        url: request.url ?? "",
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const audio = new Uint8Array([79, 103, 103, 83, 0, 1, 2, 3]);

describe("the transcription of a voice message", () => {
  it("sends the audio to the model and gives back the text", async () => {
    const model = await fakeModel({
      choices: [{ message: { content: "  Купить кофе по дороге домой.  " } }],
    });
    const transcriber = new Transcriber({
      baseUrl: model.baseUrl,
      model: "test-audio",
      timeoutMs: 5000,
      logger,
    });

    const result = await transcriber.transcribe(audio, "voice_abc.ogg");

    expect(result.ok).toBe(true);
    expect(result.text).toBe("Купить кофе по дороге домой.");

    const request = model.requests[0];
    expect(request?.url).toBe("/v1/chat/completions");
    expect(request?.body.model).toBe("test-audio");
    const messages = request?.body.messages as
      | Array<{ content: Array<Record<string, unknown>> }>
      | undefined;
    const content = messages?.[0]?.content ?? [];
    const part = content.find((item) => item.type === "input_audio") as
      | { input_audio: { data: string; format: string } }
      | undefined;
    expect(part?.input_audio.format).toBe("ogg");
    expect(Buffer.from(part?.input_audio.data ?? "", "base64")).toEqual(Buffer.from(audio));

    await model.close();
  });

  it("drops the long dashes and the quotes the model adds", async () => {
    const model = await fakeModel({
      choices: [{ message: { content: '"день — хороший"' } }],
    });
    const transcriber = new Transcriber({
      baseUrl: model.baseUrl,
      model: "test-audio",
      timeoutMs: 5000,
      logger,
    });

    const result = await transcriber.transcribe(audio, "voice_abc.ogg");
    expect(result.text).toBe("день - хороший");
    await model.close();
  });

  it("reports an audio without speech as a failure", async () => {
    const model = await fakeModel({ choices: [{ message: { content: "EMPTY" } }] });
    const transcriber = new Transcriber({
      baseUrl: model.baseUrl,
      model: "test-audio",
      timeoutMs: 5000,
      logger,
    });

    const result = await transcriber.transcribe(audio, "voice_abc.ogg");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no speech");
    await model.close();
  });

  it("reports the answer of a model that refused", async () => {
    const model = await fakeModel({ error: { message: "no such model" } }, 404);
    const transcriber = new Transcriber({
      baseUrl: model.baseUrl,
      model: "test-audio",
      timeoutMs: 5000,
      logger,
    });

    const result = await transcriber.transcribe(audio, "voice_abc.ogg");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
    await model.close();
  });

  it("does nothing when no model is configured", async () => {
    const transcriber = new Transcriber({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "",
      timeoutMs: 1000,
      logger,
    });

    expect(transcriber.enabled).toBe(false);
    const result = await transcriber.transcribe(audio, "voice_abc.ogg");
    expect(result.ok).toBe(false);
    expect(result.text).toBe("");
  });

  it("refuses an empty audio and an unknown format", async () => {
    const transcriber = new Transcriber({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-audio",
      timeoutMs: 1000,
      logger,
    });

    expect((await transcriber.transcribe(new Uint8Array(), "voice.ogg")).ok).toBe(false);
    expect((await transcriber.transcribe(audio, "notes.txt")).ok).toBe(false);
  });
});
