import type { Bot, Context } from "grammy";

/** The biggest file a bot may download from Telegram. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Raised when a file of the owner does not fit into the limit. */
export class AttachmentTooBigError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`the file is too big: ${bytes} bytes, the limit is ${limit}`);
    this.name = "AttachmentTooBigError";
  }
}

export interface IncomingAttachment {
  fileId: string;
  fileName: string;
  mimeType?: string;
  size: number;
}

/**
 * The file of a message, if the message carries one: a document, a photo, a
 * video, an audio or a voice message.
 */
export function describeAttachment(ctx: Context): IncomingAttachment | null {
  const message = ctx.message;
  if (!message) return null;

  const document = message.document;
  if (document) {
    return {
      fileId: document.file_id,
      fileName: document.file_name ?? "document",
      mimeType: document.mime_type,
      size: document.file_size ?? 0,
    };
  }

  const photo = message.photo;
  if (photo && photo.length > 0) {
    const best = photo[photo.length - 1];
    if (!best) return null;
    return {
      fileId: best.file_id,
      fileName: `photo_${best.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      size: best.file_size ?? 0,
    };
  }

  const video = message.video;
  if (video) {
    return {
      fileId: video.file_id,
      fileName: video.file_name ?? `video_${video.file_unique_id}.mp4`,
      mimeType: video.mime_type,
      size: video.file_size ?? 0,
    };
  }

  const audio = message.audio;
  if (audio) {
    return {
      fileId: audio.file_id,
      fileName: audio.file_name ?? `audio_${audio.file_unique_id}.mp3`,
      mimeType: audio.mime_type,
      size: audio.file_size ?? 0,
    };
  }

  const voice = message.voice;
  if (voice) {
    return {
      fileId: voice.file_id,
      fileName: `voice_${voice.file_unique_id}.ogg`,
      mimeType: voice.mime_type,
      size: voice.file_size ?? 0,
    };
  }

  return null;
}

/**
 * Downloads a file from Telegram.
 *
 * Telegram tells the size of a file before it is downloaded, so a file that
 * does not fit into the limit is refused before the bytes travel. The size is
 * checked once more after the download, because the declared one is a hint.
 */
export async function downloadAttachment(
  bot: Bot,
  token: string,
  fileId: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<Uint8Array> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not give a path for the file");
  }
  if (typeof file.file_size === "number" && file.file_size > maxBytes) {
    throw new AttachmentTooBigError(file.file_size, maxBytes);
  }

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`could not download the file: ${response.status}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new AttachmentTooBigError(buffer.byteLength, maxBytes);
  }
  return buffer;
}
