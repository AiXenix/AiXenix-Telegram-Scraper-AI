// A small Telegram Bot API client: JSON calls, multipart uploads, and typed
// errors. It has no dependency on the global fetch or FormData, so the same
// code works behind a proxy-aware HTTP client in the standalone script.
import { randomBytes } from "node:crypto";

export class TelegramError extends Error {
  /** HTTP-like code from the Bot API: 400 bad request, 401 bad token, 403 no rights, 409 conflict, 429 flood. */
  readonly code: number;
  readonly retryAfter: number | null;
  constructor(code: number, description: string, retryAfter: number | null = null) {
    super(description);
    this.name = "TelegramError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface UploadFile {
  /** Form field name, also the name used in attach://<field> references. */
  field: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  photo?: TgPhotoSize[];
  video?: { file_id: string; file_size?: number };
  animation?: { file_id: string };
  document?: { file_id: string; mime_type?: string };
  media_group_id?: string;
  forward_origin?: {
    type: "channel" | "user" | "hidden_user" | "chat";
    chat?: TgChat;
    message_id?: number;
    date: number;
  };
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineButton[][];

function encodeMultipart(fields: Record<string, string>, files: UploadFile[]): { body: Uint8Array; contentType: string } {
  const boundary = `----newsdesk${randomBytes(12).toString("hex")}`;
  const chunks: Uint8Array[] = [];
  const text = (value: string) => chunks.push(new TextEncoder().encode(value));
  for (const [name, value] of Object.entries(fields)) {
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  for (const file of files) {
    const safeName = file.filename.replace(/["\r\n]/gu, "_");
    text(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    );
    chunks.push(file.data);
    text("\r\n");
  }
  text(`--${boundary}--\r\n`);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export class TelegramApi {
  private readonly base: string;
  private readonly httpFetch: typeof fetch;

  constructor(options: { token: string; apiBase: string; fetch: typeof fetch }) {
    this.base = `${options.apiBase.replace(/\/+$/u, "")}/bot${options.token}`;
    this.httpFetch = options.fetch;
  }

  private async request<T>(method: string, init: { body: Uint8Array | string; contentType: string }, options: CallOptions): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.httpFetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": init.contentType },
        body: init.body as BodyInit,
        signal,
      });
    } catch (cause) {
      if (options.signal?.aborted === true) throw cause;
      // Never include the URL in the message: it carries the bot token.
      const reason = cause instanceof Error ? cause.name === "TimeoutError" ? "нет ответа" : cause.message : String(cause);
      throw new TelegramError(0, `Telegram недоступен (${method}): ${reason}`);
    }
    let envelope: ApiEnvelope<T>;
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new TelegramError(response.status, `Telegram ответил не JSON (${method}), код ${response.status}`);
    }
    if (!envelope.ok || envelope.result === undefined) {
      throw new TelegramError(
        envelope.error_code ?? response.status,
        envelope.description ?? `Ошибка Telegram (${method})`,
        envelope.parameters?.retry_after ?? null,
      );
    }
    return envelope.result;
  }

  /** One retry after a flood wait of up to 30 seconds; everything else is thrown to the caller. */
  private async withFloodRetry<T>(run: () => Promise<T>, options: CallOptions): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      if (!(cause instanceof TelegramError) || cause.code !== 429 || cause.retryAfter === null || cause.retryAfter > 30) {
        throw cause;
      }
      if (options.signal?.aborted === true) throw cause;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ((cause.retryAfter ?? 1) + 1) * 1000);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      return run();
    }
  }

  call<T>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    return this.withFloodRetry(
      () => this.request<T>(method, { body: JSON.stringify(params), contentType: "application/json" }, options),
      options,
    );
  }

  /** Multipart call. Non-string params are JSON-encoded, as the Bot API expects. */
  upload<T>(method: string, params: Record<string, unknown>, files: UploadFile[], options: CallOptions = {}): Promise<T> {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      fields[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return this.withFloodRetry(
      () => this.request<T>(method, encodeMultipart(fields, files), { timeoutMs: 180_000, ...options }),
      options,
    );
  }

  getMe(options?: CallOptions): Promise<TgUser> {
    return this.call<TgUser>("getMe", {}, options);
  }

  getUpdates(offset: number, timeoutSec: number, options: CallOptions): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
      { ...options, timeoutMs: (timeoutSec + 15) * 1000 },
    );
  }

  sendText(
    chatId: number | string,
    html: string,
    extra: { keyboard?: InlineKeyboard; replyTo?: number; disablePreview?: boolean; previewUrl?: string } = {},
    options?: CallOptions,
  ): Promise<TgMessage> {
    // previewUrl: show the preview of this address (with its picture large) whatever other links the text has.
    const preview =
      extra.disablePreview === true
        ? { link_preview_options: { is_disabled: true } }
        : extra.previewUrl === undefined
          ? {}
          : { link_preview_options: { url: extra.previewUrl, prefer_large_media: true } };
    return this.call<TgMessage>(
      "sendMessage",
      {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        ...preview,
        ...(extra.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: extra.keyboard } }),
        ...(extra.replyTo === undefined
          ? {}
          : { reply_parameters: { message_id: extra.replyTo, allow_sending_without_reply: true } }),
      },
      options,
    );
  }

  editText(
    chatId: number | string,
    messageId: number,
    html: string,
    keyboard: InlineKeyboard | null,
    options?: CallOptions,
  ): Promise<unknown> {
    return this.call(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      },
      options,
    );
  }

  answerCallback(id: string, text?: string, options?: CallOptions): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text === undefined ? {} : { text }) }, options);
  }

  deleteMessages(chatId: number | string, messageIds: number[], options?: CallOptions): Promise<unknown> {
    return this.call("deleteMessages", { chat_id: chatId, message_ids: messageIds }, options);
  }
}
