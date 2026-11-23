// A stand-in for the Telegram Bot API, strict enough to catch the mistakes the
// real one rejects: unknown or unbalanced HTML tags, texts over the limits,
// captions on the wrong item, edits of messages that do not exist.
//
// Besides the Bot API paths (/bot<token>/<method>) it has test controls:
//   POST /_test/update   deliver an update to the bot ({ message } or { callback_query })
//   GET  /_test/state    everything the bot has sent so far
//   POST /_test/too-old  {"ids": [...]} messages that, like real ones over 48 hours old, cannot be deleted
import { createServer } from "node:http";

const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "blockquote", "tg-spoiler"]);

/** Returns the visible text, or throws the way Telegram does for markup it cannot parse. */
export function parseTelegramHtml(html) {
  const stack = [];
  let visible = "";
  let last = 0;
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/gu;
  const text = (chunk) => {
    if (/[<>]/u.test(chunk)) throw new Error("Bad Request: can't parse entities: unescaped angle bracket");
    if (/&(?!(?:amp|lt|gt|quot|#\d+);)/u.test(chunk)) throw new Error("Bad Request: can't parse entities: unescaped ampersand");
    visible += chunk.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&amp;/gu, "&");
  };
  for (const match of html.matchAll(pattern)) {
    text(html.slice(last, match.index));
    last = match.index + match[0].length;
    const name = match[2].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) throw new Error(`Bad Request: can't parse entities: unsupported start tag "${name}"`);
    if (match[1] === "/") {
      if (stack.pop() !== name) throw new Error(`Bad Request: can't parse entities: unexpected end tag "${name}"`);
    } else {
      if (name === "a" && !/^\s+href="[^"]+"\s*$/u.test(match[3])) {
        throw new Error("Bad Request: can't parse entities: tag \"a\" must have an href");
      }
      if (name !== "a" && match[3].trim() !== "") throw new Error(`Bad Request: can't parse entities: unexpected attribute in "${name}"`);
      stack.push(name);
    }
  }
  text(html.slice(last));
  if (stack.length > 0) throw new Error(`Bad Request: can't parse entities: can't find end tag for "${stack.pop()}"`);
  return visible;
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(.+)$/u.exec(contentType)?.[1];
  if (boundary === undefined) throw new Error("Bad Request: no multipart boundary");
  const fields = {};
  const files = {};
  const delimiter = Buffer.from(`--${boundary}`);
  let position = buffer.indexOf(delimiter);
  while (position !== -1) {
    const next = buffer.indexOf(delimiter, position + delimiter.length);
    if (next === -1) break;
    const part = buffer.subarray(position + delimiter.length + 2, next - 2);
    const headerEnd = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const name = /name="([^"]+)"/u.exec(headers)?.[1];
    if (name !== undefined) {
      if (/filename="/u.test(headers)) files[name] = { size: body.length, type: /Content-Type: (.+)/iu.exec(headers)?.[1] ?? "" };
      else fields[name] = body.toString("utf8");
    }
    position = next;
  }
  return { fields, files };
}

export function startMockTelegram({ port = 0, longPollMs = 800 } = {}) {
  const state = {
    updates: [],
    nextUpdateId: 1000,
    nextMessageId: 500,
    /** Every message the bot sent or edited, newest last. */
    messages: [],
    calls: [],
    answers: [],
    deleted: [],
    tooOld: new Set(),
    waiters: [],
  };

  const wake = () => {
    for (const resolve of state.waiters.splice(0)) resolve();
  };

  const record = (chatId, fields) => {
    const message = { message_id: (state.nextMessageId += 1), chat_id: String(chatId), date: Math.floor(Date.now() / 1000), ...fields };
    state.messages.push(message);
    return message;
  };

  const apiMessage = (message) => ({
    message_id: message.message_id,
    date: message.date,
    chat: { id: Number(message.chat_id) || message.chat_id, type: String(message.chat_id).startsWith("@") ? "channel" : "private" },
    ...(message.text === undefined ? {} : { text: message.visible }),
    ...(message.caption === undefined ? {} : { caption: message.visible }),
    ...(message.media?.kind === "photo" ? { photo: [{ file_id: `photo-small-${message.message_id}`, width: 90, height: 90 }, { file_id: `photo-${message.message_id}`, width: 1280, height: 720 }] } : {}),
    ...(message.media?.kind === "video" ? { video: { file_id: `video-${message.message_id}` } } : {}),
  });

  const requireChat = (params) => {
    if (params.chat_id === undefined || params.chat_id === "") throw new Error("Bad Request: chat_id is empty");
    return params.chat_id;
  };

  const mediaInput = (params, files, key, kind) => {
    const value = params[key];
    if (typeof value !== "string" || value === "") throw new Error(`Bad Request: there is no ${key} in the request`);
    if (value.startsWith("attach://")) {
      const file = files[value.slice("attach://".length)];
      if (file === undefined) throw new Error("Bad Request: attached file not found");
      if (file.size === 0) throw new Error("Bad Request: file must be non-empty");
      return { kind, source: "upload", size: file.size };
    }
    return { kind, source: "file_id", fileId: value };
  };

  const caption = (params, limit) => {
    if (params.caption === undefined) return {};
    if (params.parse_mode !== "HTML") throw new Error("Bad Request: test server expects parse_mode HTML");
    const visible = parseTelegramHtml(params.caption);
    if (visible.length > limit) throw new Error("Bad Request: message caption is too long");
    return { caption: params.caption, visible };
  };

  const methods = {
    getMe: () => ({ id: 4242, is_bot: true, first_name: "Newsdesk Test", username: "newsdesk_test_bot" }),
    async getUpdates(params) {
      const offset = Number(params.offset ?? 0);
      state.updates = state.updates.filter((update) => update.update_id >= offset);
      if (state.updates.length === 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, longPollMs);
          state.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return state.updates.filter((update) => update.update_id >= offset);
    },
    sendMessage(params) {
      const chatId = requireChat(params);
      if (typeof params.text !== "string" || params.text === "") throw new Error("Bad Request: message text is empty");
      if (params.parse_mode !== "HTML") throw new Error("Bad Request: test server expects parse_mode HTML");
      const visible = parseTelegramHtml(params.text);
      if (visible.length > 4096) throw new Error("Bad Request: message is too long");
      const keyboard = params.reply_markup?.inline_keyboard ?? null;
      const preview = params.link_preview_options ?? null;
      if (preview?.url !== undefined && !/^https?:\/\//u.test(preview.url)) throw new Error("Bad Request: wrong link preview url");
      return apiMessage(
        record(chatId, {
          text: params.text,
          visible,
          keyboard,
          reply_to: params.reply_parameters?.message_id ?? null,
          preview_url: preview?.is_disabled === true ? null : (preview?.url ?? null),
        }),
      );
    },
    sendPhoto(params, files) {
      const chatId = requireChat(params);
      const media = mediaInput(params, files, "photo", "photo");
      return apiMessage(record(chatId, { media, reply_to: params.reply_parameters?.message_id ?? null, ...caption(params, 1024) }));
    },
    sendVideo(params, files) {
      const chatId = requireChat(params);
      const media = mediaInput(params, files, "video", "video");
      return apiMessage(record(chatId, { media, reply_to: params.reply_parameters?.message_id ?? null, ...caption(params, 1024) }));
    },
    sendMediaGroup(params, files) {
      const chatId = requireChat(params);
      const items = params.media;
      if (!Array.isArray(items) || items.length < 2 || items.length > 10) throw new Error("Bad Request: media group must include 2-10 items");
      const group = `group-${state.nextMessageId + 1}`;
      return items.map((item, index) => {
        if (item.type !== "photo" && item.type !== "video") throw new Error("Bad Request: wrong type of the media");
        const media = mediaInput({ media: item.media }, files, "media", item.type);
        // The service puts the text on the first photo or video, or on the last file of a file album.
        const captionAt = item.type === "document" ? items.length - 1 : 0;
        if (index !== captionAt && item.caption !== undefined) throw new Error("Bad Request: test server expects the caption on one item only");
        return apiMessage(record(chatId, { media, group, reply_to: index === 0 ? (params.reply_parameters?.message_id ?? null) : null, ...(index === captionAt ? caption(item, 1024) : {}) }));
      });
    },
    editMessageText(params) {
      const message = state.messages.find(
        (candidate) => candidate.message_id === Number(params.message_id) && candidate.chat_id === String(params.chat_id),
      );
      if (message === undefined || message.text === undefined) throw new Error("Bad Request: message to edit not found");
      const visible = parseTelegramHtml(params.text);
      const keyboard = params.reply_markup?.inline_keyboard ?? [];
      if (message.text === params.text && JSON.stringify(message.keyboard ?? []) === JSON.stringify(keyboard)) {
        throw new Error("Bad Request: message is not modified");
      }
      message.text = params.text;
      message.visible = visible;
      message.keyboard = keyboard.length === 0 ? null : keyboard;
      message.edits = (message.edits ?? 0) + 1;
      return apiMessage(message);
    },
    editMessageReplyMarkup(params) {
      const message = state.messages.find(
        (candidate) => candidate.message_id === Number(params.message_id) && candidate.chat_id === String(params.chat_id),
      );
      if (message === undefined) throw new Error("Bad Request: message to edit not found");
      const keyboard = params.reply_markup?.inline_keyboard ?? [];
      if (JSON.stringify(message.keyboard ?? []) === JSON.stringify(keyboard)) throw new Error("Bad Request: message is not modified");
      message.keyboard = keyboard.length === 0 ? null : keyboard;
      return apiMessage(message);
    },
    answerCallbackQuery(params) {
      state.answers.push({ id: params.callback_query_id, text: params.text ?? null, alert: params.show_alert === true });
      return true;
    },
    deleteMessages(params) {
      const chatId = String(requireChat(params));
      const ids = params.message_ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw new Error("Bad Request: message_ids must hold 1-100 ids");
      const wanted = new Set(ids.map(Number));
      // Like the real API: one message that is too old makes the whole call fail.
      if (ids.some((id) => state.tooOld.has(Number(id)))) throw new Error("Bad Request: message can't be deleted for everyone");
      state.deleted.push(...ids.map(Number));
      state.messages = state.messages.filter((message) => !(message.chat_id === chatId && wanted.has(message.message_id)));
      return true;
    },
    setMyCommands(params) {
      if (!Array.isArray(params.commands) || params.commands.some((item) => !/^[a-z0-9_]{1,32}$/u.test(item.command) || !item.description)) {
        throw new Error("Bad Request: BOT_COMMAND_INVALID");
      }
      state.commands = params.commands;
      return true;
    },
    getChatMember(params) {
      const chat = String(requireChat(params));
      if (chat === "@not_a_member") throw new Error("Bad Request: member list is inaccessible");
      if (chat === "@no_post_right") return { status: "administrator", can_post_messages: false, user: { id: Number(params.user_id) } };
      return { status: "administrator", can_post_messages: true, user: { id: Number(params.user_id) } };
    },
  };

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const url = new URL(request.url, "http://localhost");
    try {
      if (url.pathname === "/_test/state") {
        send(200, { messages: state.messages, calls: state.calls, answers: state.answers, deleted: state.deleted, pendingUpdates: state.updates.length });
        return;
      }
      if (url.pathname === "/_test/too-old") {
        for (const id of JSON.parse(body.toString("utf8")).ids ?? []) state.tooOld.add(Number(id));
        send(200, { ok: true });
        return;
      }
      if (url.pathname === "/_test/update") {
        const update = JSON.parse(body.toString("utf8"));
        if (update.message !== undefined) {
          update.message.message_id ??= state.nextMessageId += 1;
          update.message.date ??= Math.floor(Date.now() / 1000);
        }
        state.updates.push({ update_id: (state.nextUpdateId += 1), ...update });
        wake();
        send(200, { ok: true });
        return;
      }
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(url.pathname);
      if (match === null) {
        send(404, { ok: false, error_code: 404, description: "Not Found" });
        return;
      }
      if (match[1] === "invalid") {
        send(401, { ok: false, error_code: 401, description: "Unauthorized" });
        return;
      }
      const method = methods[match[2]];
      if (method === undefined) {
        send(404, { ok: false, error_code: 404, description: `Not Found: method ${match[2]} is not implemented by the test server` });
        return;
      }
      const contentType = request.headers["content-type"] ?? "";
      let params = {};
      let files = {};
      if (contentType.startsWith("multipart/form-data")) {
        const parsed = parseMultipart(body, contentType);
        files = parsed.files;
        for (const [key, value] of Object.entries(parsed.fields)) {
          // Structured fields arrive JSON-encoded in multipart requests.
          params[key] = /^[[{]/u.test(value) || value === "true" || value === "false" ? JSON.parse(value) : value;
        }
      } else if (body.length > 0) {
        params = JSON.parse(body.toString("utf8"));
      }
      state.calls.push({ method: match[2], chat_id: params.chat_id === undefined ? null : String(params.chat_id), at: Date.now() });
      send(200, { ok: true, result: await method(params, files) });
    } catch (cause) {
      send(400, { ok: false, error_code: 400, description: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        state,
        close: () =>
          new Promise((done) => {
            wake();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// Run directly to keep a test server up: node mock-telegram.mjs [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockTelegram({ port: Number(process.argv[2] ?? 8089) });
  console.log(`mock Telegram Bot API on ${mock.url}`);
}
