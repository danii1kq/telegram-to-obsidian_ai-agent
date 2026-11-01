import type { Logger } from "../logger.js";

/**
 * Turns a voice message into text.
 *
 * The audio goes to the same local proxy the agent talks to, so the key of the
 * provider never leaves the process and the request is routed exactly like
 * every other one. The model is an OpenAI compatible chat model that accepts
 * audio parts; when it is not configured the transcription is simply off and
 * the voice message is stored as a file, the way it was before.
 */

export interface TranscriberOptions {
  /** Base address of the local proxy, `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** The model that understands audio; empty disables the transcription. */
  model: string;
  timeoutMs: number;
  logger: Logger;
}

export interface TranscriptionResult {
  ok: boolean;
  text: string;
  error?: string;
}

/** The audio formats the model is known to accept. */
const SUPPORTED_FORMATS = new Set(["ogg", "oga", "mp3", "m4a", "wav", "flac", "webm"]);

/** The biggest audio that is sent to the model, in bytes. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export class Transcriber {
  constructor(private readonly options: TranscriberOptions) {}

  /** True when a model is configured, so a voice message can be read. */
  get enabled(): boolean {
    return this.options.model.length > 0;
  }

  /**
   * Transcribes one audio file.
   *
   * The answer of the model is a plain text. Anything that looks like a
   * refusal or an empty answer is reported as a failure, so the caller can
   * fall back to storing the file without a text.
   */
  async transcribe(data: Uint8Array, fileName: string): Promise<TranscriptionResult> {
    if (!this.enabled) return { ok: false, text: "", error: "the transcription is off" };
    if (data.byteLength === 0) return { ok: false, text: "", error: "the audio is empty" };
    if (data.byteLength > MAX_AUDIO_BYTES) {
      return { ok: false, text: "", error: "the audio is too big" };
    }

    const format = formatOf(fileName);
    if (!SUPPORTED_FORMATS.has(format)) {
      return { ok: false, text: "", error: `the format ${format} is not supported` };
    }

    const body = {
      model: this.options.model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Transcribe this audio message into plain text.",
                "Write exactly what is said, in the language it is said.",
                "No headers, no comments, no quotes around the text, no long dashes.",
                "If the audio has no speech, answer with the single word EMPTY.",
              ].join(" "),
            },
            {
              type: "input_audio",
              input_audio: {
                data: Buffer.from(data).toString("base64"),
                format,
              },
            },
          ],
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        this.options.logger.warn("the model refused the transcription", {
          status: response.status,
          detail: detail.slice(0, 300),
        });
        return { ok: false, text: "", error: `the model answered with ${response.status}` };
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const text = readContent(payload.choices?.[0]?.message?.content);
      if (!text) return { ok: false, text: "", error: "the model gave no text" };
      if (/^empty$/i.test(text)) return { ok: false, text: "", error: "there is no speech" };
      return { ok: true, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("the transcription failed", { error: message });
      return { ok: false, text: "", error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The content of a message is a string or a list of parts. */
function readContent(content: unknown): string {
  if (typeof content === "string") return clean(content);
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean);
    return clean(parts.join(" "));
  }
  return "";
}

/** Trims the answer and drops the wrapping the model likes to add. */
function clean(text: string): string {
  return text
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/, "")
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .replace(/[—–‒―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** The format of the audio from the name of the file. */
function formatOf(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  // Telegram sends a voice message as ogg, the model knows it as ogg.
  return extension === "oga" ? "ogg" : extension;
}
