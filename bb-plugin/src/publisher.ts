// Sends a post (text with optional photo, video or album) to a chat. The same
// function shows the preview to the owner and publishes to the channel.
import type { StoredMedia } from "./pipeline.ts";
import { TelegramError, type TelegramApi, type TgMessage, type UploadFile } from "./telegram.ts";
import { CAPTION_LIMIT } from "./pipeline.ts";
import { visibleLength } from "./text.ts";

/** Bot API upload ceilings, with a little headroom. */
const MAX_PHOTO_BYTES = 9_500_000;
const MAX_VIDEO_BYTES = 49_000_000;

export interface SentPost {
  messageIds: number[];
  /** File ids Telegram assigned to the media, in order; reusing them avoids a second upload. */
  media: StoredMedia[];
}

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

async function download(httpFetch: typeof fetch, url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(120_000);
  let response: Response;
  try {
    response = await httpFetch(url, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    throw new MediaError(`не удалось скачать файл: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) throw new MediaError(`не удалось скачать файл: код ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new MediaError(`файл больше ${Math.round(maxBytes / 1_000_000)} МБ`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > maxBytes) throw new MediaError(`файл больше ${Math.round(maxBytes / 1_000_000)} МБ`);
  if (data.byteLength === 0) throw new MediaError("файл пустой");
  return data;
}

function fileIdOf(message: TgMessage): string | null {
  if (message.photo !== undefined && message.photo.length > 0) {
    return (message.photo[message.photo.length - 1] as { file_id: string }).file_id;
  }
  return message.video?.file_id ?? message.animation?.file_id ?? message.document?.file_id ?? null;
}

const SINGLE_METHOD = { photo: "sendPhoto", video: "sendVideo", animation: "sendAnimation", document: "sendDocument" } as const;

/**
 * What can go out in one message: one item of any kind, or an album. Telegram
 * mixes photos and videos in an album, puts files only with files, and never
 * puts a GIF in one; whatever does not fit is left out.
 */
export function sendableSet(media: StoredMedia[]): StoredMedia[] {
  const items = media.filter(
    (item) => item.kind === "photo" || item.kind === "video" || ((item.kind === "animation" || item.kind === "document") && item.fileId !== undefined),
  );
  if (items.length <= 1) return items;
  const visual = items.filter((item) => item.kind === "photo" || item.kind === "video");
  if (visual.length >= 1) return visual.slice(0, 10);
  const documents = items.filter((item) => item.kind === "document");
  if (documents.length >= 1) return documents.slice(0, 10);
  return items.slice(0, 1);
}

/**
 * Sends the post. `media` items carry either a Telegram file id (sent as is)
 * or a URL (downloaded and uploaded). Throws MediaError when a file cannot be
 * fetched or is too large, so the caller can fall back to text only.
 */
export async function sendPost(
  api: TelegramApi,
  httpFetch: typeof fetch,
  chatId: number | string,
  html: string,
  media: StoredMedia[],
  signal?: AbortSignal,
  options: { replyTo?: number } = {},
): Promise<SentPost> {
  const items = sendableSet(media);
  const reply =
    options.replyTo === undefined ? {} : { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } };
  if (items.length === 0) {
    const message = await api.sendText(chatId, html, options.replyTo === undefined ? {} : { replyTo: options.replyTo }, { signal });
    return { messageIds: [message.message_id], media: [] };
  }
  if (visibleLength(html) > CAPTION_LIMIT) {
    throw new MediaError(`текст длиннее подписи к медиа (${visibleLength(html)} из ${CAPTION_LIMIT} знаков)`);
  }

  const files: UploadFile[] = [];
  const references: string[] = [];
  for (const [index, item] of items.entries()) {
    if (item.fileId !== undefined) {
      references.push(item.fileId);
      continue;
    }
    if (item.url === null || (item.kind !== "photo" && item.kind !== "video")) throw new MediaError("у медиа нет ни файла, ни адреса");
    const isVideo = item.kind === "video";
    const data = await download(httpFetch, item.url, isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES, signal);
    const field = `file${index}`;
    files.push({
      field,
      filename: isVideo ? `video${index}.mp4` : `photo${index}.jpg`,
      contentType: isVideo ? "video/mp4" : "image/jpeg",
      data,
    });
    references.push(`attach://${field}`);
  }

  try {
    if (items.length === 1) {
      const item = items[0] as StoredMedia;
      const kind = item.kind as keyof typeof SINGLE_METHOD;
      const params = {
        chat_id: chatId,
        [kind]: references[0],
        caption: html,
        parse_mode: "HTML",
        ...(kind === "video" ? { supports_streaming: true } : {}),
        ...reply,
      };
      const method = SINGLE_METHOD[kind];
      const message =
        files.length === 0
          ? await api.call<TgMessage>(method, params, { signal })
          : await api.upload<TgMessage>(method, params, files, { signal });
      const fileId = fileIdOf(message);
      return {
        messageIds: [message.message_id],
        media: fileId === null ? [] : [{ kind: item.kind, url: null, fileId }],
      };
    }
    // Telegram shows an album's caption under it only when it is on the first photo or video;
    // in an album of files every caption sits under its own file, so the text goes on the last one.
    const captionAt = items[0]?.kind === "document" ? items.length - 1 : 0;
    const group = items.map((item, index) => ({
      type: item.kind === "video" ? "video" : item.kind === "document" ? "document" : "photo",
      media: references[index],
      ...(index === captionAt ? { caption: html, parse_mode: "HTML" } : {}),
    }));
    const params = { chat_id: chatId, media: group, ...reply };
    const messages =
      files.length === 0
        ? await api.call<TgMessage[]>("sendMediaGroup", params, { signal })
        : await api.upload<TgMessage[]>("sendMediaGroup", params, files, { signal });
    const sentMedia: StoredMedia[] = [];
    messages.forEach((message, index) => {
      const fileId = fileIdOf(message);
      const kind = (items[index] as StoredMedia).kind;
      if (fileId !== null) sentMedia.push({ kind, url: null, fileId });
    });
    return {
      messageIds: messages.map((message) => message.message_id),
      media: sentMedia.length === items.length ? sentMedia : [],
    };
  } catch (cause) {
    // Telegram refusing the media itself (wrong type, broken file) is a media problem, not a fatal one.
    if (cause instanceof TelegramError && cause.code === 400 && /photo|video|media|file|wrong type|IMAGE|DIMENSIONS/iu.test(cause.message)) {
      throw new MediaError(`Telegram не принял медиа: ${cause.message}`);
    }
    throw cause;
  }
}
