// The Telegram side: proposals with buttons, the owner's commands, and posts
// the owner forwards by hand. Works the same in both runtimes.
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { StoryRow } from "./db.ts";
import { EngineError, MANUAL_REASON, REJECT_REASONS, type Engine } from "./engine.ts";
import type { StoredMedia } from "./pipeline.ts";
import { errorMessage } from "./platform.ts";
import { MediaError, sendPost } from "./publisher.ts";
import type {
  InlineKeyboard,
  TelegramApi,
  TgCallbackQuery,
  TgMessage,
  TgMessageEntity,
  TgUpdate,
} from "./telegram.ts";
import { escapeHtml, fingerprint, htmlToPlain, truncate } from "./text.ts";

const ENTITY_TAGS: Record<string, string> = {
  bold: "b",
  italic: "i",
  underline: "u",
  strikethrough: "s",
  code: "code",
  pre: "pre",
  spoiler: "tg-spoiler",
  blockquote: "blockquote",
};

/** A Telegram message's text and entities as the HTML the Bot API accepts back. */
export function entitiesToHtml(text: string, entities: TgMessageEntity[]): string {
  const supported = entities.filter((entity) => entity.type in ENTITY_TAGS || (entity.type === "text_link" && entity.url));
  const cuts = new Set<number>([0, text.length]);
  for (const entity of supported) {
    cuts.add(Math.max(0, Math.min(text.length, entity.offset)));
    cuts.add(Math.max(0, Math.min(text.length, entity.offset + entity.length)));
  }
  const points = [...cuts].sort((left, right) => left - right);
  let html = "";
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index] as number;
    const end = points[index + 1] as number;
    const active = supported.filter((entity) => entity.offset <= start && entity.offset + entity.length >= end);
    const open = active
      .map((entity) =>
        entity.type === "text_link"
          ? `<a href="${escapeHtml(entity.url ?? "").replace(/"/gu, "&quot;")}">`
          : `<${ENTITY_TAGS[entity.type]}>`,
      )
      .join("");
    const close = [...active]
      .reverse()
      .map((entity) => (entity.type === "text_link" ? "</a>" : `</${ENTITY_TAGS[entity.type]}>`))
      .join("");
    html += `${open}${escapeHtml(text.slice(start, end))}${close}`;
  }
  return html;
}

/** Plain text for the model, with hidden link addresses written out after their labels. */
export function entitiesToPlain(text: string, entities: TgMessageEntity[]): { text: string; links: string[] } {
  const links: string[] = [];
  const hidden = entities
    .filter((entity) => entity.type === "text_link" && entity.url)
    .sort((left, right) => right.offset - left.offset);
  let result = text;
  for (const entity of hidden) {
    const end = entity.offset + entity.length;
    result = `${result.slice(0, end)} (${entity.url})${result.slice(end)}`;
    links.push(entity.url as string);
  }
  for (const entity of entities) {
    if (entity.type === "url") links.push(text.slice(entity.offset, entity.offset + entity.length));
  }
  return { text: result, links: links.map((link) => (/^https?:\/\//iu.test(link) ? link : `https://${link}`)) };
}

const HELP = [
  "<b>Что я умею</b>",
  "Сам слежу за каналами из списка, отбираю новости и присылаю готовые посты с кнопками «Разместить» и «Отказать».",
  "",
  "Перешлите мне любой пост — подготовлю его вне очереди.",
  "",
  "/status — как идут дела",
  "/sources — список каналов",
  "/add @канал — добавить канал",
  "/remove @канал — убрать канал",
  "/pause @канал и /resume @канал — приостановить и вернуть",
  "/queue — что ждёт решения",
  "/collect — проверить каналы сейчас",
  "/cancel — выйти из правки текста",
].join("\n");

/**
 * Every button carries the tag of the service copy that sent it. If two
 * copies ever share one bot, a press meant for one cannot act on the other's
 * story with the same number.
 */
function mainKeyboard(storyId: number, tag: string): InlineKeyboard {
  return [
    [
      { text: "✅ Разместить", callback_data: `p:${storyId}@${tag}` },
      { text: "❌ Отказать", callback_data: `r:${storyId}@${tag}` },
    ],
    [
      { text: "🔁 Другой вариант", callback_data: `a:${storyId}@${tag}` },
      { text: "✏️ Править", callback_data: `e:${storyId}@${tag}` },
    ],
  ];
}

function editKeyboard(storyId: number, tag: string): InlineKeyboard {
  return [
    [{ text: "Написать, что изменить", callback_data: `ei:${storyId}@${tag}` }],
    [{ text: "Прислать свой текст", callback_data: `et:${storyId}@${tag}` }],
    [{ text: "← Назад", callback_data: `b:${storyId}@${tag}` }],
  ];
}

function reasonKeyboard(storyId: number, tag: string): InlineKeyboard {
  return [
    REJECT_REASONS.slice(0, 2).map((reason, index) => ({ text: reason, callback_data: `rr:${storyId}:${index}@${tag}` })),
    REJECT_REASONS.slice(2).map((reason, index) => ({ text: reason, callback_data: `rr:${storyId}:${index + 2}@${tag}` })),
  ];
}

interface EditMode {
  storyId: number;
  mode: "instruction" | "text";
  startedAt: number;
}

export class BotController {
  private readonly engine: Engine;
  private editMode: EditMode | null = null;
  private readonly albums = new Map<string, { messages: TgMessage[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  dispose(): void {
    for (const album of this.albums.values()) clearTimeout(album.timer);
    this.albums.clear();
  }

  /** A short random mark of this copy of the service, kept in its database. */
  private tag(): string {
    const existing = this.engine.store.getState<string>("instance_tag");
    if (existing !== null) return existing;
    const created = randomBytes(3).toString("hex");
    this.engine.store.setState("instance_tag", created);
    return created;
  }

  // ---- proposals -------------------------------------------------------------

  private controlText(story: StoryRow, extraNote: string | null = null): string {
    const posts = this.engine.store.postsOfStory(story.id);
    const first = posts[0];
    const byHand = story.manual === 1 && story.reason === MANUAL_REASON;
    const origin = byHand ? " · прислано вручную" : story.manual === 1 ? " · возвращено в работу" : "";
    const lines = [
      `<b>№${story.id}</b>${story.score === null || byHand ? "" : ` · оценка ${story.score}`}${origin}${story.draft_version > 1 ? ` · вариант ${story.draft_version}` : ""}`,
      escapeHtml(story.title),
    ];
    if (first !== undefined) {
      const label = first.source_handle === "manual" ? "ваше сообщение" : `@${first.source_handle}`;
      const link = first.url === "" ? escapeHtml(label) : `<a href="${escapeHtml(first.url)}">${escapeHtml(label)}</a>`;
      lines.push(`Источник: ${link}${posts.length > 1 ? ` и ещё ${posts.length - 1}` : ""}`);
    }
    if (story.reason && !byHand) lines.push(`${story.manual === 1 ? "Было отсеяно" : "Почему"}: ${escapeHtml(truncate(story.reason, 200))}`);
    const notes = [story.draft_note, extraNote].filter((note): note is string => typeof note === "string" && note !== "");
    if (notes.length > 0) lines.push(`Заметка: ${escapeHtml(truncate(notes.join(" "), 400))}`);
    return lines.join("\n");
  }

  private controlMessageId(story: StoryRow): { chatId: number; messageId: number } | null {
    if (story.proposal_chat_id === null || story.proposal_message_ids === null) return null;
    try {
      const ids = JSON.parse(story.proposal_message_ids) as number[];
      const last = ids[ids.length - 1];
      return last === undefined ? null : { chatId: story.proposal_chat_id, messageId: last };
    } catch {
      return null;
    }
  }

  /** Sends the preview (exactly what the channel will get) and the message with buttons under it. */
  async sendProposal(api: TelegramApi, ownerChatId: number, story: StoryRow, signal: AbortSignal): Promise<void> {
    if (story.draft_html === null) return;
    const store = this.engine.store;
    let sent;
    let mediaNote: string | null = null;
    try {
      sent = await sendPost(api, this.engine.platform.fetch, ownerChatId, story.draft_html, this.engine.mediaFor(story), signal);
    } catch (cause) {
      if (!(cause instanceof MediaError)) throw cause;
      mediaNote = `Медиа не приложено: ${cause.message}.`;
      store.updateStory(story.id, { media_post_id: null, proposal_media: null });
      sent = await sendPost(api, this.engine.platform.fetch, ownerChatId, story.draft_html, [], signal);
    }
    const control = await api.sendText(
      ownerChatId,
      this.controlText(story, mediaNote),
      { keyboard: mainKeyboard(story.id, this.tag()), replyTo: sent.messageIds[0], disablePreview: true },
      { signal },
    );
    store.updateStory(story.id, {
      proposal_chat_id: ownerChatId,
      proposal_message_ids: JSON.stringify([...sent.messageIds, control.message_id]),
      proposal_media: sent.media.length > 0 ? JSON.stringify(sent.media) : null,
    });
  }

  private async editControl(story: StoryRow, html: string, keyboard: InlineKeyboard | null): Promise<void> {
    const target = this.controlMessageId(story);
    if (target === null) return;
    try {
      const api = this.engine.api(await this.engine.config());
      if (api === null) return;
      await api.editText(target.chatId, target.messageId, html, keyboard);
    } catch {
      // The message may be gone or unchanged; the decision itself is already saved.
    }
  }

  /**
   * Takes a proposal out of the owner's chat: deletes its preview and its
   * message with buttons. Returns how many messages went. If Telegram refuses
   * (messages older than 48 hours cannot be deleted), the buttons are removed instead.
   */
  async removeProposal(api: TelegramApi, story: StoryRow): Promise<number> {
    if (story.proposal_chat_id === null || story.proposal_message_ids === null) return 0;
    let ids: number[] = [];
    try {
      ids = JSON.parse(story.proposal_message_ids) as number[];
    } catch {
      return 0;
    }
    if (ids.length === 0) return 0;
    try {
      await api.deleteMessages(story.proposal_chat_id, ids);
      return ids.length;
    } catch {
      await this.retireProposal(story, "снято");
      return 0;
    }
  }

  /** Marks an outdated proposal so its buttons cannot be pressed by mistake. */
  retireProposal(story: StoryRow, label: string): Promise<void> {
    return this.editControl(story, `<b>№${story.id}</b> · ${escapeHtml(label)}`, null);
  }

  /** Deletes a proposal's messages from the chat (used when a new variant replaces it). */
  async dropProposal(story: StoryRow): Promise<void> {
    const api = this.engine.api(await this.engine.config());
    if (api === null) return;
    await this.removeProposal(api, story);
  }

  /** The first words of the post, for the one-line outcome message. */
  private opening(story: StoryRow): string {
    const text = story.draft_html === null ? story.title : htmlToPlain(story.draft_html);
    const line = text.replace(/\s+/gu, " ").trim();
    return escapeHtml(truncate(line, 90));
  }

  /**
   * Replaces a decided proposal with one short line: the preview and the
   * message with buttons are deleted, and a single message states the outcome.
   * Once collapsed, later updates (a reject reason) edit that line in place.
   * If Telegram refuses the deletion, the message with buttons is edited instead.
   */
  private async collapse(story: StoryRow, html: string, keyboard: InlineKeyboard | null): Promise<void> {
    if (story.proposal_chat_id === null || story.proposal_message_ids === null) return;
    let ids: number[] = [];
    try {
      ids = JSON.parse(story.proposal_message_ids) as number[];
    } catch {
      return;
    }
    if (ids.length <= 1) {
      await this.editControl(story, html, keyboard);
      return;
    }
    const api = this.engine.api(await this.engine.config());
    if (api === null) return;
    try {
      await api.deleteMessages(story.proposal_chat_id, ids);
    } catch {
      await this.editControl(story, html, keyboard);
      return;
    }
    try {
      const sent = await api.sendText(story.proposal_chat_id, html, { disablePreview: true, ...(keyboard === null ? {} : { keyboard }) });
      this.engine.store.updateStory(story.id, { proposal_message_ids: JSON.stringify([sent.message_id]) });
    } catch {
      this.engine.store.updateStory(story.id, { proposal_message_ids: JSON.stringify([]) });
    }
  }

  /** Brings the proposal in line with a decision made anywhere (bot, admin page, console). */
  async afterDecision(story: StoryRow): Promise<void> {
    const opening = this.opening(story);
    if (story.status === "published") {
      const link = story.published_url === null ? "" : ` <a href="${escapeHtml(story.published_url)}">открыть</a>`;
      const note = story.last_error === null ? "" : `\n${escapeHtml(story.last_error)}`;
      await this.collapse(story, `✅ Размещено №${story.id}: «${opening}»${link}${note}`, null);
    } else if (story.status === "rejected") {
      if (story.decision_reason === null) {
        await this.collapse(story, `❌ Отклонено №${story.id}: «${opening}»\nПричина, если не трудно:`, reasonKeyboard(story.id, this.tag()));
      } else {
        await this.collapse(story, `❌ Отклонено №${story.id}: «${opening}» — ${escapeHtml(story.decision_reason)}`, null);
      }
    }
  }

  /** A proposal nobody decided on in time. */
  afterExpiry(story: StoryRow, hours: number): Promise<void> {
    return this.collapse(story, `⌛ Не рассмотрено за ${hours} ч, убрано в отсев №${story.id}: «${this.opening(story)}»`, null);
  }

  // ---- updates ---------------------------------------------------------------

  async handleUpdate(api: TelegramApi, config: Config, update: TgUpdate, signal: AbortSignal): Promise<void> {
    if (update.callback_query !== undefined) {
      await this.handleCallback(api, config, update.callback_query, signal);
      return;
    }
    const message = update.message;
    if (message === undefined || message.chat.type !== "private") return;
    await this.handleMessage(api, config, message, signal);
  }

  private async handleCallback(api: TelegramApi, config: Config, query: TgCallbackQuery, signal: AbortSignal): Promise<void> {
    if (config.telegram.ownerChatId === null || query.from.id !== config.telegram.ownerChatId) {
      await api.answerCallback(query.id, "Этот бот работает только с владельцем").catch(() => undefined);
      return;
    }
    const [payload = "", sender] = (query.data ?? "").split("@");
    if (sender !== undefined && sender !== this.tag()) {
      // Buttons without a tag come from before tags existed and belong to this copy.
      await api
        .call("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Это предложение прислала другая копия сервиса. Ответьте на него там или остановите вторую копию.",
          show_alert: true,
        })
        .catch(() => undefined);
      return;
    }
    const [action, rawId, rawExtra] = payload.split(":");
    const storyId = Number.parseInt(rawId ?? "", 10);
    if (action === undefined || !Number.isFinite(storyId)) {
      await api.answerCallback(query.id).catch(() => undefined);
      return;
    }
    const answer = (text?: string) => api.answerCallback(query.id, text, { signal }).catch(() => undefined);
    try {
      switch (action) {
        case "p": {
          await answer("Публикую…");
          await this.engine.decide(storyId, "publish", { signal });
          return;
        }
        case "r": {
          await this.engine.decide(storyId, "reject");
          await answer("Отклонено");
          return;
        }
        case "rr": {
          const reason = REJECT_REASONS[Number.parseInt(rawExtra ?? "", 10)];
          if (reason !== undefined) {
            const story = this.engine.setRejectReason(storyId, reason);
            await this.afterDecision(story);
          }
          await answer("Записал");
          return;
        }
        case "a": {
          const story = this.engine.requireStory(storyId);
          this.engine.requestRewrite(storyId, null);
          await answer("Готовлю другой вариант");
          await this.editControl(story, `<b>№${storyId}</b> · готовлю другой вариант…`, null);
          return;
        }
        case "e": {
          const story = this.engine.requireStory(storyId);
          await answer();
          await this.editControl(story, this.controlText(story), editKeyboard(storyId, this.tag()));
          return;
        }
        case "b": {
          const story = this.engine.requireStory(storyId);
          this.editMode = null;
          await answer();
          await this.editControl(story, this.controlText(story), mainKeyboard(storyId, this.tag()));
          return;
        }
        case "ei":
        case "et": {
          const story = this.engine.requireStory(storyId);
          if (story.status !== "proposed") throw new EngineError("Это предложение уже не ждёт решения");
          this.editMode = { storyId, mode: action === "ei" ? "instruction" : "text", startedAt: Date.now() };
          await answer();
          await api.sendText(
            query.from.id,
            action === "ei"
              ? `Напишите одним сообщением, что изменить в №${storyId}. Например: «короче», «убери последний абзац», «добавь ссылку на репозиторий». /cancel — передумал.`
              : `Пришлите одним сообщением новый текст для №${storyId}. Оформление (жирный, ссылки) сохранится. /cancel — передумал.`,
            {},
            { signal },
          );
          return;
        }
        case "rs": {
          await this.engine.decide(storyId, "restore");
          await answer("Вернул в работу");
          return;
        }
        default:
          await answer();
      }
    } catch (cause) {
      if (signal.aborted) return;
      const text = cause instanceof EngineError ? cause.message : `Ошибка: ${errorMessage(cause)}`;
      await api
        .call("answerCallbackQuery", { callback_query_id: query.id, text: truncate(text, 190), show_alert: true })
        .catch(() => undefined);
      // The callback may already be answered; make sure the owner sees a failed publication.
      if (action === "p") await api.sendText(query.from.id, `⚠️ ${escapeHtml(text)}`, { disablePreview: true }).catch(() => undefined);
    }
  }

  private async handleMessage(api: TelegramApi, config: Config, message: TgMessage, signal: AbortSignal): Promise<void> {
    const chatId = message.chat.id;
    const text = (message.text ?? "").trim();
    const reply = (html: string, keyboard?: InlineKeyboard) =>
      api.sendText(chatId, html, { disablePreview: true, ...(keyboard === undefined ? {} : { keyboard }) }, { signal });
    const owner = config.telegram.ownerChatId;

    if (text.startsWith("/start")) {
      const code = text.split(/\s+/u)[1] ?? "";
      if (owner === null) {
        if (code !== "" && code === this.engine.pairingCode()) {
          await this.engine.pairOwner(chatId);
          await reply(`Готово, теперь я работаю с вами.\n\n${HELP}`);
        } else {
          await reply("Этот бот ещё не привязан к владельцу. Отправьте /start и код из админки или из окна программы, например: /start 123456");
        }
        return;
      }
      if (chatId === owner) await reply(HELP);
      else await reply("Этот бот работает только со своим владельцем.");
      return;
    }
    if (owner === null || chatId !== owner) {
      await reply("Этот бот работает только со своим владельцем.");
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(text, reply, signal);
      return;
    }
    if (this.editMode !== null && Date.now() - this.editMode.startedAt < 30 * 60_000 && message.forward_origin === undefined) {
      await this.applyEdit(message, reply);
      return;
    }
    this.editMode = null;

    if (message.media_group_id !== undefined) {
      const key = `${chatId}:${message.media_group_id}`;
      const existing = this.albums.get(key);
      if (existing !== undefined) {
        existing.messages.push(message);
        return;
      }
      const timer = setTimeout(() => {
        const album = this.albums.get(key);
        this.albums.delete(key);
        if (album === undefined) return;
        this.acceptMaterial(album.messages, reply).catch((cause: unknown) => {
          this.engine.log("error", "bot", `Не удалось принять альбом: ${errorMessage(cause)}`);
        });
      }, 1500);
      this.albums.set(key, { messages: [message], timer });
      return;
    }
    await this.acceptMaterial([message], reply);
  }

  private async handleCommand(
    text: string,
    reply: (html: string, keyboard?: InlineKeyboard) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const [rawCommand, ...rest] = text.split(/\s+/u);
    const command = (rawCommand ?? "").replace(/@.*$/u, "").toLowerCase();
    const argument = rest.join(" ").trim();
    try {
      switch (command) {
        case "/help":
          await reply(HELP);
          return;
        case "/cancel":
          this.editMode = null;
          await reply("Хорошо, правку отменил.");
          return;
        case "/status": {
          const overview = await this.engine.overview("");
          const counts = overview.counts;
          const lines = [
            `<b>Состояние</b>`,
            `Источников: ${overview.sources.enabled} из ${overview.sources.total}${overview.sources.failing > 0 ? `, не читается: ${overview.sources.failing}` : ""}`,
            `Последний сбор: ${overview.collector.lastRunAt === null ? "ещё не было" : new Date(overview.collector.lastRunAt).toLocaleString("ru-RU")}`,
            `Ждут разбора: ${overview.newPosts}, ждут черновика: ${counts.candidate ?? 0}, ждут решения: ${counts.proposed ?? 0}`,
            `Опубликовано: ${counts.published ?? 0}, отклонено: ${counts.rejected ?? 0}, отсеяно: ${counts.filtered ?? 0}${(counts.failed ?? 0) > 0 ? `, не удалось подготовить: ${counts.failed}` : ""}`,
          ];
          for (const problem of overview.problems) lines.push(`⚠️ ${escapeHtml(problem)}`);
          await reply(lines.join("\n"));
          return;
        }
        case "/sources": {
          const sources = this.engine.listSources();
          if (sources.length === 0) {
            await reply("Список пуст. Добавьте канал: /add @канал");
            return;
          }
          const lines = sources.map((source) => {
            const state = !source.enabled ? " — на паузе" : source.lastError !== null ? ` — ошибка: ${escapeHtml(truncate(source.lastError, 80))}` : "";
            return `@${source.handle}${source.title === null ? "" : ` (${escapeHtml(truncate(source.title, 40))})`}${state}`;
          });
          await reply(`<b>Источники (${sources.length})</b>\n${lines.join("\n")}`);
          return;
        }
        case "/add": {
          if (argument === "") {
            await reply("Напишите так: /add @канал или /add https://t.me/канал");
            return;
          }
          const added: string[] = [];
          const failed: string[] = [];
          for (const item of argument.split(/[\s,]+/u).filter(Boolean).slice(0, 20)) {
            try {
              const source = await this.engine.addSource(item, signal);
              added.push(`@${source.handle}${source.title === null ? "" : ` (${escapeHtml(truncate(source.title, 40))})`}`);
            } catch (cause) {
              failed.push(`${escapeHtml(item)}: ${escapeHtml(errorMessage(cause))}`);
            }
          }
          const lines: string[] = [];
          if (added.length > 0) lines.push(`Добавил: ${added.join(", ")}`);
          if (failed.length > 0) lines.push(`Не получилось:\n${failed.join("\n")}`);
          await reply(lines.join("\n"));
          return;
        }
        case "/remove":
          await this.engine.removeSource(argument);
          await reply(`Убрал ${escapeHtml(argument)}.`);
          return;
        case "/pause":
          await this.engine.setSourceEnabled(argument, false);
          await reply(`Поставил ${escapeHtml(argument)} на паузу.`);
          return;
        case "/resume":
          await this.engine.setSourceEnabled(argument, true);
          await reply(`Вернул ${escapeHtml(argument)}.`);
          return;
        case "/collect":
          this.engine.kickCollector();
          await reply("Проверяю каналы. Если появится что-то стоящее, пришлю.");
          return;
        case "/queue": {
          const waiting = this.engine.listStories({ statuses: ["proposed"], limit: 20 });
          if (waiting.length === 0) {
            await reply("Сейчас ничего не ждёт решения.");
            return;
          }
          // Send them again: old messages with buttons may be far up the chat.
          for (const story of waiting) {
            this.engine.store.updateStory(story.id, { proposal_chat_id: null, proposal_message_ids: null });
          }
          this.engine.kickPipeline();
          await reply(`Ждут решения: ${waiting.length}. Присылаю ещё раз.`);
          return;
        }
        default:
          await reply("Не знаю такой команды. /help — что я умею.");
      }
    } catch (cause) {
      if (signal.aborted) return;
      await reply(`⚠️ ${escapeHtml(errorMessage(cause))}`);
    }
  }

  private async applyEdit(message: TgMessage, reply: (html: string) => Promise<unknown>): Promise<void> {
    const mode = this.editMode;
    if (mode === null) return;
    const text = message.text ?? message.caption ?? "";
    if (text.trim() === "") {
      await reply("Нужен текст. /cancel — выйти из правки.");
      return;
    }
    this.editMode = null;
    try {
      if (mode.mode === "instruction") {
        this.engine.requestRewrite(mode.storyId, truncate(text.trim(), 1000));
        await reply(`Принял. Переписываю №${mode.storyId}, пришлю новый вариант.`);
      } else {
        await this.engine.setDraft(mode.storyId, entitiesToHtml(text, message.entities ?? message.caption_entities ?? []));
        await reply(`Текст №${mode.storyId} заменил, сейчас пришлю, как он будет выглядеть.`);
      }
    } catch (cause) {
      await reply(`⚠️ ${escapeHtml(errorMessage(cause))}`);
    }
  }

  /** One message, or the messages of one album, sent or forwarded by the owner as material for a post. */
  private async acceptMaterial(
    messages: TgMessage[],
    reply: (html: string, keyboard?: InlineKeyboard) => Promise<unknown>,
  ): Promise<void> {
    const ordered = [...messages].sort((left, right) => left.message_id - right.message_id);
    const withText = ordered.find((item) => (item.text ?? item.caption ?? "").trim() !== "") ?? (ordered[0] as TgMessage);
    const raw = withText.text ?? withText.caption ?? "";
    const { text, links } = entitiesToPlain(raw, withText.entities ?? withText.caption_entities ?? []);
    if (text.trim().length < 20) {
      await reply("Здесь почти нет текста, писать пост не из чего. Перешлите пост с текстом или пришлите ссылку с описанием.");
      return;
    }
    const media: StoredMedia[] = [];
    for (const item of ordered) {
      if (item.photo !== undefined && item.photo.length > 0) {
        media.push({ kind: "photo", url: null, fileId: (item.photo[item.photo.length - 1] as { file_id: string }).file_id });
      } else if (item.video !== undefined) {
        media.push({ kind: "video", url: null, fileId: item.video.file_id });
      }
    }
    const origin = withText.forward_origin;
    const fromChannel = origin?.type === "channel" && origin.chat !== undefined;
    const username = fromChannel ? origin.chat?.username?.toLowerCase() : undefined;
    const sourceHandle = fromChannel ? (username ?? `c${Math.abs(origin.chat?.id ?? 0)}`) : "manual";
    const msgId = fromChannel && origin.message_id !== undefined ? origin.message_id : withText.message_id;
    const result = this.engine.acceptManual({
      sourceHandle,
      msgId,
      url: username === undefined ? "" : `https://t.me/${username}/${msgId}`,
      postedAt: new Date((origin?.date ?? withText.date) * 1000).toISOString(),
      text,
      links,
      media,
      fingerprint: fingerprint(text),
    });
    if (result.kind === "known") {
      const story = result.story;
      if (story.status === "published" || story.status === "own") {
        await reply(`Похоже, это уже есть на канале${story.published_url === null ? "" : `: ${escapeHtml(story.published_url)}`}\n«${escapeHtml(truncate(story.title, 120))}»`);
      } else if (story.status === "rejected") {
        await reply(`Вы уже отклоняли это как №${story.id}${story.decision_reason === null ? "" : ` (${escapeHtml(story.decision_reason)})`}.`, [
          [{ text: "Вернуть в работу", callback_data: `rs:${story.id}@${this.tag()}` }],
        ]);
      } else {
        this.engine.store.updateStory(story.id, { proposal_chat_id: null, proposal_message_ids: null });
        this.engine.kickPipeline();
        await reply(`Это уже ждёт решения как №${story.id}. Присылаю ещё раз.`);
      }
      return;
    }
    const warning =
      result.similar === null
        ? ""
        : `\nПохожее уже было на канале: «${escapeHtml(truncate(result.similar.title, 100))}»${result.similar.published_url === null ? "" : ` ${escapeHtml(result.similar.published_url)}`}`;
    await reply(`Принял, готовлю пост №${result.storyId}.${warning}`);
  }
}
