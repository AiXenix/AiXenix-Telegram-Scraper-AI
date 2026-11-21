// The engine: everything the service does, independent of where it runs.
// The bb plugin and the standalone script both create one Engine and start
// the same four loops (collector, pipeline, bot, maintenance).
import { randomInt } from "node:crypto";
import { BotController } from "./bot.ts";
import { NOT_STARTED, collectSource, pageFetcher, probeSource, type CollectResult } from "./collector.ts";
import { normalizeSources, serializeSources, type Config, type SourceEntry } from "./config.ts";
import type { EventRow, PostRow, SourceRow, Store, StoryRow, StoryStatus } from "./db.ts";
import { nowIso } from "./db.ts";
import {
  MANUAL_REASON,
  MESSAGE_LIMIT,
  parseMedia,
  pickMediaPost,
  triageBatch,
  usableMedia,
  writeDraft,
  type PipelineContext,
  type StoredMedia,
} from "./pipeline.ts";
import { errorMessage, sleep, type ConfigStore, type LlmRunner, type Platform } from "./platform.ts";
import { MediaError, sendPost } from "./publisher.ts";
import { TelegramApi, TelegramError, type TgUser } from "./telegram.ts";
import {
  contentTokens,
  escapeHtml,
  firstSentence,
  linkKeys,
  sanitizeTelegramHtml,
  truncate,
  visibleLength,
} from "./text.ts";
import { TmeError, channelTarget, parseChannelHandle } from "./tme.ts";

export interface EngineDeps {
  store: Store;
  platform: Platform;
  configStore: ConfigStore;
  llm: LlmRunner;
}

export interface SourceView {
  handle: string;
  title: string | null;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastPostAt: string | null;
  lastError: string | null;
  posts: number;
  published: number;
  rejected: number;
}

export interface StorySourceView {
  handle: string;
  url: string;
  postedAt: string;
  text: string;
  media: { kind: string; sendable: boolean }[];
}

export interface StoryView {
  id: number;
  status: StoryStatus;
  title: string;
  summary: string;
  score: number | null;
  reason: string | null;
  draftHtml: string | null;
  draftVersion: number;
  draftNote: string | null;
  manual: boolean;
  hasMedia: boolean;
  rewriting: boolean;
  lastError: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  sources: StorySourceView[];
}

export type BotState = "off" | "starting" | "ok" | "bad_token" | "conflict" | "error";

export interface Overview {
  runtime: string;
  counts: Record<string, number>;
  newPosts: number;
  sources: { total: number; enabled: number; failing: number };
  collector: { enabled: boolean; lastRunAt: string | null; pollMinutes: number };
  pipeline: { enabled: boolean; lastError: string | null; pausedUntil: string | null };
  bot: { state: BotState; username: string | null; detail: string | null };
  owner: { paired: boolean; pairingCode: string | null };
  channel: string;
  ownPosts: number;
  llm: { backend: string; stats: { task: string; model: string; runs: number; failed: number; avgMs: number }[] };
  problems: string[];
}

export type DecisionAction = "publish" | "reject" | "regenerate" | "restore";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/** Runs tasks one after another, so a reset never overlaps a collection round or a pipeline step. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const BOT_COMMANDS = [
  { command: "status", description: "Как идут дела" },
  { command: "queue", description: "Что ждёт решения" },
  { command: "sources", description: "Список каналов" },
  { command: "add", description: "Добавить канал: /add @канал" },
  { command: "remove", description: "Убрать канал: /remove @канал" },
  { command: "pause", description: "Приостановить канал: /pause @канал" },
  { command: "resume", description: "Вернуть канал: /resume @канал" },
  { command: "collect", description: "Проверить каналы сейчас" },
  { command: "cancel", description: "Выйти из правки текста" },
  { command: "help", description: "Что я умею" },
];

/** Lets a loop sleep until its next tick, or wake early when there is work. */
class Waker {
  private wake: (() => void) | null = null;
  private pending = false;
  kick(): void {
    // A kick that arrives while the loop is busy must not be lost: the next wait returns at once.
    if (this.wake === null) this.pending = true;
    else this.wake();
  }
  async wait(ms: number, signal: AbortSignal): Promise<void> {
    // An already aborted signal fires no event, so check it before listening.
    if (signal.aborted) return;
    if (this.pending) {
      this.pending = false;
      return;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.wake = () => controller.abort();
    await sleep(ms, controller.signal);
    this.wake = null;
    signal.removeEventListener("abort", onAbort);
  }
}

export const REJECT_REASONS = ["не по теме", "уже было", "слабая новость", "реклама"] as const;
export { MANUAL_REASON };

export class Engine {
  readonly store: Store;
  readonly platform: Platform;
  private readonly configStore: ConfigStore;
  private readonly llm: LlmRunner;
  private readonly bot: BotController;

  private readonly collectorWaker = new Waker();
  private readonly pipelineWaker = new Waker();
  private readonly collectSerial = new Serial();
  private readonly pipelineSerial = new Serial();
  private readonly rewriteQueue: { storyId: number; instruction: string | null }[] = [];
  private readonly triageAttempts = new Map<number, number>();
  private pipelinePausedUntil = 0;
  private pipelineFailures = 0;
  private pipelineLastError: string | null = null;
  private deliverNotBefore = 0;
  private botState: BotState = "off";
  private botDetail: string | null = null;
  private botUser: TgUser | null = null;
  private lastOwnerAlertAt = 0;
  private ownChannelLoaded = false;
  private lastOwnError: string | null = null;
  /** True while this process runs the bot loop; otherwise the state comes from the copy that does. */
  private runsBot = false;
  /** Why the bot cannot post to the channel, or null when it can (or when that is not known yet). */
  private channelProblem: string | null = null;
  private channelCheckedAt = 0;
  private channelCheckedFor = "";

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.platform = deps.platform;
    this.configStore = deps.configStore;
    this.llm = deps.llm;
    this.bot = new BotController(this);
  }

  // ---- config --------------------------------------------------------------

  config(): Promise<Config> {
    return this.configStore.load();
  }

  async updateConfig(mutate: (config: Config) => Config | void): Promise<Config> {
    const current = await this.configStore.load();
    const draft = structuredClone(current) as Config;
    const next = mutate(draft) ?? draft;
    await this.configStore.save(next);
    this.platform.changed();
    return next;
  }

  api(config: Config): TelegramApi | null {
    if (config.telegram.botToken.trim() === "") return null;
    return new TelegramApi({
      token: config.telegram.botToken.trim(),
      apiBase: config.telegram.apiBase,
      fetch: this.platform.fetch,
    });
  }

  private ownHandle(config: Config): string | null {
    return parseChannelHandle(config.telegram.channel);
  }

  /**
   * Asks Telegram whether the bot may post to the channel, so that a missing
   * right shows up as a problem on the status page, not as a failed
   * publication. Runs when the bot or the channel changes and twice an hour.
   */
  private async checkChannelAccess(api: TelegramApi, config: Config, botId: number, signal: AbortSignal): Promise<void> {
    const raw = config.telegram.channel.trim();
    const channel = channelTarget(raw);
    const key = `${botId}:${raw}`;
    // While there is a problem, look again every minute, so fixing the rights in Telegram shows up quickly.
    const interval = this.channelProblem === null ? 30 * 60_000 : 60_000;
    if (key === this.channelCheckedFor && Date.now() - this.channelCheckedAt < interval) return;
    this.channelCheckedFor = key;
    this.channelCheckedAt = Date.now();
    const before = this.channelProblem;
    if (raw === "") {
      this.channelProblem = "Не задан канал для публикаций (telegram.channel).";
    } else if (channel === null) {
      this.channelProblem = `Канал для публикаций указан неверно: «${raw}». Нужно @имя канала.`;
    } else {
      try {
        const member = await api.call<{ status: string; can_post_messages?: boolean }>(
          "getChatMember",
          { chat_id: channel, user_id: botId },
          { signal },
        );
        const canPost = member.status === "creator" || (member.status === "administrator" && member.can_post_messages !== false);
        this.channelProblem = canPost
          ? null
          : `Бот не может публиковать в ${channel}: сделайте его администратором канала с правом публикации сообщений.`;
      } catch (cause) {
        if (signal.aborted) return;
        // Telegram answers 400 or 403 when the bot is not in the channel at all; anything else says nothing about rights.
        const code = cause instanceof TelegramError ? cause.code : 0;
        this.channelProblem =
          code === 400 || code === 403
            ? `Бот не добавлен в ${channel} или канал указан неверно: добавьте бота администратором с правом публикации сообщений.`
            : null;
      }
    }
    if (this.channelProblem !== before) {
      if (this.channelProblem !== null) this.log("warn", "bot", this.channelProblem);
      else if (before !== null) this.log("info", "bot", "Право публиковать в канал есть.");
      this.saveRuntime();
      this.platform.changed();
    }
  }

  // ---- pairing -------------------------------------------------------------

  /** Six digits the owner sends to the bot as /start <code> to claim it. */
  pairingCode(): string {
    const existing = this.store.getState<string>("pairing_code");
    if (existing !== null) return existing;
    const code = String(randomInt(100_000, 1_000_000));
    this.store.setState("pairing_code", code);
    return code;
  }

  async pairOwner(chatId: number): Promise<void> {
    await this.updateConfig((config) => {
      config.telegram.ownerChatId = chatId;
    });
    this.store.deleteState("pairing_code");
    this.log("info", "owner", `Владелец привязан: чат ${chatId}`);
  }

  // ---- sources -------------------------------------------------------------

  private sourceEntries(config: Config): SourceEntry[] {
    const own = this.ownHandle(config);
    return normalizeSources(config, parseChannelHandle).filter((entry) => entry.handle !== own);
  }

  /** Makes the database match the sources list in the config. */
  async syncSources(signal?: AbortSignal): Promise<void> {
    const config = await this.config();
    const entries = this.sourceEntries(config);
    const wanted = new Map(entries.map((entry) => [entry.handle, entry]));
    for (const row of this.store.listSources()) {
      const entry = wanted.get(row.handle);
      if (entry === undefined) {
        this.store.removeSource(row.id);
        continue;
      }
      if ((row.enabled === 1) !== entry.enabled) this.store.setSourceEnabled(row.id, entry.enabled);
      wanted.delete(row.handle);
    }
    for (const entry of wanted.values()) {
      try {
        const probe = await probeSource(entry.handle, signal, pageFetcher(this.platform.fetch));
        const row = this.store.addSource(entry.handle, probe.title, probe.cursor);
        if (!entry.enabled) this.store.setSourceEnabled(row.id, false);
      } catch (cause) {
        if (signal?.aborted === true) throw cause;
        // Keep the source visible with its error instead of silently dropping it.
        const row = this.store.addSource(entry.handle, null, NOT_STARTED);
        if (!entry.enabled) this.store.setSourceEnabled(row.id, false);
        this.store.markSourceError(row.id, errorMessage(cause));
      }
    }
  }

  async addSource(input: string, signal?: AbortSignal): Promise<{ handle: string; title: string | null }> {
    const handle = parseChannelHandle(input);
    if (handle === null) {
      throw new EngineError("Не похоже на адрес канала. Нужен @name или ссылка вида https://t.me/name");
    }
    const config = await this.config();
    if (handle === this.ownHandle(config)) throw new EngineError("Это ваш собственный канал, его добавлять не нужно");
    if (this.sourceEntries(config).some((entry) => entry.handle === handle)) {
      throw new EngineError(`Канал @${handle} уже в списке`);
    }
    let probe: Awaited<ReturnType<typeof probeSource>>;
    try {
      probe = await probeSource(handle, signal, pageFetcher(this.platform.fetch));
    } catch (cause) {
      throw new EngineError(cause instanceof TmeError ? cause.message : `Не удалось прочитать канал: ${errorMessage(cause)}`);
    }
    await this.updateConfig((draft) => {
      draft.sources = serializeSources([...this.sourceEntries(draft), { handle, enabled: true }]);
    });
    if (this.store.getSourceByHandle(handle) === undefined) this.store.addSource(handle, probe.title, probe.cursor);
    this.log("info", "source", `Добавлен источник @${handle}`);
    this.collectorWaker.kick();
    this.platform.changed();
    return { handle, title: probe.title };
  }

  async removeSource(input: string): Promise<void> {
    const handle = parseChannelHandle(input);
    const config = await this.config();
    if (handle === null || !this.sourceEntries(config).some((entry) => entry.handle === handle)) {
      throw new EngineError(`Канала ${input} нет в списке`);
    }
    await this.updateConfig((draft) => {
      draft.sources = serializeSources(this.sourceEntries(draft).filter((entry) => entry.handle !== handle));
    });
    const row = this.store.getSourceByHandle(handle);
    if (row !== undefined) this.store.removeSource(row.id);
    this.log("info", "source", `Удалён источник @${handle}`);
    this.platform.changed();
  }

  async setSourceEnabled(input: string, enabled: boolean): Promise<void> {
    const handle = parseChannelHandle(input);
    const config = await this.config();
    if (handle === null || !this.sourceEntries(config).some((entry) => entry.handle === handle)) {
      throw new EngineError(`Канала ${input} нет в списке`);
    }
    await this.updateConfig((draft) => {
      draft.sources = serializeSources(
        this.sourceEntries(draft).map((entry) => (entry.handle === handle ? { handle, enabled } : entry)),
      );
    });
    const row = this.store.getSourceByHandle(handle);
    if (row !== undefined) this.store.setSourceEnabled(row.id, enabled);
    if (enabled) this.collectorWaker.kick();
    this.platform.changed();
  }

  listSources(): SourceView[] {
    const stats = this.store.sourceStats();
    return this.store.listSources().map((row: SourceRow) => {
      const stat = stats.get(row.handle) ?? { posts: 0, published: 0, rejected: 0 };
      return {
        handle: row.handle,
        title: row.title,
        enabled: row.enabled === 1,
        lastCheckedAt: row.last_checked_at,
        lastPostAt: row.last_post_at,
        lastError: row.last_error,
        ...stat,
      };
    });
  }

  // ---- collecting ----------------------------------------------------------

  collectOnce(signal: AbortSignal, onlyHandle?: string): Promise<CollectResult[]> {
    return this.collectSerial.run(() => this.collectNow(signal, onlyHandle));
  }

  private async collectNow(signal: AbortSignal, onlyHandle?: string): Promise<CollectResult[]> {
    await this.syncSources(signal);
    const config = await this.config();
    const results: CollectResult[] = [];
    const sources = this.store
      .listSources()
      .filter((row) => row.enabled === 1 && (onlyHandle === undefined || row.handle === onlyHandle));
    for (const source of sources) {
      if (signal.aborted) break;
      const result = await collectSource(this.store, source, config, signal, pageFetcher(this.platform.fetch));
      results.push(result);
      if (result.error !== null) {
        const failures = this.store.getSource(source.id)?.error_count ?? 0;
        if (failures === 5) {
          this.log("warn", "source", `Источник @${source.handle} не читается пятый раз подряд: ${result.error}`);
          void this.alertOwner(`Источник @${source.handle} не читается: ${escapeHtml(result.error)}`);
        }
      }
      await sleep(1200, signal);
    }
    this.store.setState("collector_last_run", nowIso());
    const stored = results.reduce((sum, result) => sum + result.stored, 0);
    if (stored > 0) {
      this.pipelineWaker.kick();
      this.platform.changed();
    }
    return results;
  }

  /**
   * A clean start: forgets every collected post, proposal and filtered entry,
   * takes the pending proposals out of the owner's chat, and moves every
   * source to its latest post, so only what appears from now on is proposed.
   * What is already on the owner's channel stays in memory.
   */
  resetFromNow(signal: AbortSignal): Promise<{ stories: number; posts: number; sources: number; messages: number }> {
    return this.collectSerial.run(() => this.pipelineSerial.run(() => this.resetNow(signal)));
  }

  private async resetNow(signal: AbortSignal): Promise<{ stories: number; posts: number; sources: number; messages: number }> {
    const config = await this.config();
    const api = this.api(config);
    let messages = 0;
    if (api !== null) {
      for (;;) {
        const batch = this.store
          .listStories({ statuses: ["proposed", "publishing", "candidate", "failed"], limit: 100, offset: 0 })
          .filter((story) => story.proposal_message_ids !== null);
        if (batch.length === 0) break;
        for (const story of batch) {
          messages += await this.bot.removeProposal(api, story);
          this.store.updateStory(story.id, { proposal_chat_id: null, proposal_message_ids: null });
        }
      }
    }
    this.rewriteQueue.length = 0;
    this.triageAttempts.clear();
    const removed = this.store.clearWork();
    const fetchPage = pageFetcher(this.platform.fetch);
    let sources = 0;
    for (const source of this.store.listSources()) {
      if (signal.aborted) break;
      try {
        const page = await fetchPage(source.handle, { signal });
        const newest = page.posts[page.posts.length - 1];
        // Never move a cursor back: that would bring old posts in again.
        this.store.setSourceCursor(source.id, Math.max(newest?.id ?? 0, source.cursor));
        sources += 1;
      } catch (cause) {
        if (signal.aborted) throw cause;
        // The cursor already points at the last post seen; the next round carries on from there.
      }
      await sleep(600, signal);
    }
    this.pipelineFailures = 0;
    this.pipelineLastError = null;
    this.pipelinePausedUntil = 0;
    this.log("info", "reset", `Сброс: удалено сюжетов ${removed.stories}, постов ${removed.posts}. Слежу за каналами с этого момента.`);
    this.platform.changed();
    return { ...removed, sources, messages };
  }

  /** Reads the owner's channel so that what is already there is never proposed again. */
  async refreshOwnChannel(signal: AbortSignal, pages = 1): Promise<number> {
    const config = await this.config();
    const handle = this.ownHandle(config);
    if (handle === null) return 0;
    const fetchPage = pageFetcher(this.platform.fetch);
    let added = 0;
    let before: number | undefined;
    for (let index = 0; index < pages; index += 1) {
      const page = await fetchPage(handle, before === undefined ? { signal } : { before, signal });
      for (const post of page.posts) {
        if (this.store.hasOwnPost(post.id)) continue;
        const text = post.text.trim();
        let storyId: number | null = null;
        if (text.length >= 40) {
          const story = this.store.createStory({
            status: "own",
            title: truncate(firstSentence(text), 140),
            summary: truncate(text.replace(/\s+/gu, " "), 500),
            tokens: contentTokens(text),
            linkKeys: linkKeys(post.links),
            createdAt: new Date(post.date).toISOString(),
          });
          storyId = story.id;
        }
        this.store.addOwnPost(post.id, new Date(post.date).toISOString(), text, storyId);
        added += 1;
      }
      const oldest = page.posts[0];
      if (oldest === undefined) break;
      before = oldest.id;
    }
    if (added > 0) this.platform.changed();
    return added;
  }

  /** Says once (not on every attempt) that the own channel cannot be read, and what that means. */
  private reportOwnChannelError(cause: unknown): void {
    const message = errorMessage(cause);
    if (message === this.lastOwnError) return;
    this.lastOwnError = message;
    this.log(
      "warn",
      "own",
      `Не удалось прочитать свой канал: ${message}. Публиковать это не мешает, но посты канала, опубликованные не через сервис, не попадут в память повторов.`,
    );
  }

  // ---- pipeline ------------------------------------------------------------

  private pipelineContext(config: Config, signal: AbortSignal): PipelineContext {
    return { store: this.store, llm: this.llm, config, signal };
  }

  private pausePipeline(cause: unknown): void {
    this.pipelineFailures += 1;
    this.pipelineLastError = errorMessage(cause);
    const minutes = [1, 2, 5, 10, 20][Math.min(this.pipelineFailures - 1, 4)] as number;
    this.pipelinePausedUntil = Date.now() + minutes * 60_000;
    this.log("error", "pipeline", `Ошибка модели: ${this.pipelineLastError}. Пауза ${minutes} мин.`);
    this.saveRuntime();
    if (this.pipelineFailures === 3) {
      void this.alertOwner(`Модель не отвечает третий раз подряд: ${escapeHtml(this.pipelineLastError)}`);
    }
  }

  /** One round of work. Returns true when something was processed, so the loop runs again at once. */
  pipelineStep(signal: AbortSignal): Promise<boolean> {
    return this.pipelineSerial.run(() => this.pipelineNow(signal));
  }

  private async pipelineNow(signal: AbortSignal): Promise<boolean> {
    const config = await this.config();
    let worked = false;
    if (config.schedule.pipelineEnabled && Date.now() >= this.pipelinePausedUntil) {
      const ctx = this.pipelineContext(config, signal);
      // Before the first triage the memory must hold what is already on the
      // channel, or the first batch could propose it again.
      if (!this.ownChannelLoaded) {
        await this.refreshOwnChannel(signal, this.store.countOwnPosts() === 0 ? 8 : 1).then(
          () => {
            this.lastOwnError = null;
          },
          (cause: unknown) => {
            if (!signal.aborted) this.reportOwnChannelError(cause);
          },
        );
        if (signal.aborted) return false;
        this.ownChannelLoaded = true;
      }
      try {
        const rewrite = this.rewriteQueue[0];
        if (rewrite !== undefined) {
          await this.draft(rewrite.storyId, signal, { instruction: rewrite.instruction, rewrite: true });
          this.rewriteQueue.shift();
          worked = true;
        } else if (this.store.countNewPosts() > 0) {
          const outcome = await triageBatch(ctx);
          for (const postId of outcome.unresolved) {
            const attempts = (this.triageAttempts.get(postId) ?? 0) + 1;
            this.triageAttempts.set(postId, attempts);
            if (attempts >= 3) {
              this.store.settlePost(postId, { state: "skipped", skipReason: "модель не дала оценку" });
              this.triageAttempts.delete(postId);
            }
          }
          worked = outcome.processed > 0;
          if (outcome.processed > 0) {
            this.log(
              "info",
              "triage",
              `Разобрано постов: ${outcome.processed}. В очередь: ${outcome.candidates}, повторов: ${outcome.duplicates}, отсеяно: ${outcome.filtered + outcome.skipped}`,
            );
            this.platform.changed();
          }
        } else {
          const since = new Date(Date.now() - 86_400_000).toISOString();
          const candidates = this.store.nextCandidates(1);
          const next = candidates[0];
          // Two brakes on drafting: the daily quota, and a backlog the owner has not got to yet.
          const quotaLeft =
            this.store.proposedSince(since) < config.editorial.maxProposalsPerDay &&
            (this.store.countByStatus().proposed ?? 0) < config.editorial.maxProposalsPerDay;
          if (next !== undefined && (quotaLeft || next.manual === 1)) {
            await this.draft(next.id, signal);
            worked = true;
          }
        }
        if (this.pipelineLastError !== null) {
          this.pipelineLastError = null;
          this.saveRuntime();
        }
        this.pipelineFailures = 0;
      } catch (cause) {
        if (signal.aborted) return false;
        // A failed rewrite must not block the queue behind it forever.
        this.rewriteQueue.shift();
        this.pausePipeline(cause);
      }
    }
    await this.deliverProposals(signal);
    return worked;
  }

  /** Writes or rewrites the draft of one story and puts it in front of the owner. */
  async draft(
    storyId: number,
    signal: AbortSignal,
    options: { instruction?: string | null; rewrite?: boolean } = {},
  ): Promise<void> {
    const story = this.store.getStory(storyId);
    if (story === undefined) return;
    if (story.status !== "candidate" && story.status !== "proposed") return;
    const config = await this.config();
    try {
      const draft = await writeDraft(this.pipelineContext(config, signal), story, options);
      if (story.proposal_message_ids !== null) await this.bot.dropProposal(story);
      this.store.updateStory(storyId, {
        status: "proposed",
        draft_html: draft.html,
        draft_version: story.draft_version + 1,
        draft_note: draft.note,
        media_post_id: draft.mediaPostId,
        attempts: 0,
        last_error: null,
        proposal_chat_id: null,
        proposal_message_ids: null,
        proposal_media: null,
      });
      this.log("info", "draft", `Готов черновик №${storyId} (вариант ${story.draft_version + 1})`, storyId);
      this.platform.changed();
    } catch (cause) {
      if (signal.aborted) throw cause;
      if (story.status === "proposed" && story.proposal_message_ids !== null) {
        // The old variant's buttons were taken away for the rewrite; send it again so a decision is possible.
        await this.bot.dropProposal(story);
        this.store.updateStory(storyId, { proposal_chat_id: null, proposal_message_ids: null });
      }
      const attempts = story.attempts + 1;
      const failed = attempts >= 3 && story.status === "candidate";
      this.store.updateStory(storyId, {
        attempts,
        last_error: errorMessage(cause),
        ...(failed ? { status: "failed" as StoryStatus } : {}),
      });
      this.log("error", "draft", `Черновик №${storyId} не получился: ${errorMessage(cause)}`, storyId);
      if (failed) {
        void this.notifyOwner(
          `⚠️ Черновик №${storyId} «${escapeHtml(truncate(story.title, 80))}» не удалось подготовить после трёх попыток: ${escapeHtml(truncate(errorMessage(cause), 200))}\nКогда причина устранена, верните его в работу: restore ${storyId}.`,
        );
      }
      this.platform.changed();
      throw cause;
    }
  }

  /** Queues a rewrite for the pipeline loop and returns at once. */
  requestRewrite(storyId: number, instruction: string | null): void {
    const story = this.requireStory(storyId);
    if (story.status !== "proposed") throw new EngineError("Переписать можно только предложение, которое ждёт решения");
    if (!this.rewriteQueue.some((item) => item.storyId === storyId)) {
      this.rewriteQueue.push({ storyId, instruction });
    }
    this.pipelineWaker.kick();
    this.platform.changed();
  }

  private isRewriting(storyId: number): boolean {
    return this.rewriteQueue.some((item) => item.storyId === storyId);
  }

  // ---- proposals and decisions ----------------------------------------------

  /** Media to send with a story: the preview's file ids when there are any, else the source's files. */
  mediaFor(story: StoryRow): StoredMedia[] {
    if (story.proposal_media !== null) {
      const stored = parseMedia(story.proposal_media);
      if (stored.length > 0) return stored;
    }
    if (story.media_post_id === null) return [];
    const post = this.store.getPost(story.media_post_id);
    return post === undefined ? [] : usableMedia(post);
  }

  private async deliverProposals(signal: AbortSignal): Promise<void> {
    if (Date.now() < this.deliverNotBefore) return;
    // Another program is polling this bot: it would receive the button presses, so do not send anything.
    if (this.botState === "conflict") return;
    const pending = this.store.unsentProposals();
    if (pending.length === 0) return;
    const config = await this.config();
    const api = this.api(config);
    const owner = config.telegram.ownerChatId;
    if (api === null || owner === null) return;
    for (const story of pending) {
      if (signal.aborted) return;
      try {
        await this.bot.sendProposal(api, owner, story, signal);
      } catch (cause) {
        if (signal.aborted) return;
        this.deliverNotBefore = Date.now() + 60_000;
        this.log("warn", "bot", `Не удалось отправить предложение №${story.id} в Telegram: ${errorMessage(cause)}`, story.id);
        return;
      }
    }
  }

  requireStory(storyId: number): StoryRow {
    const story = this.store.getStory(storyId);
    if (story === undefined) throw new EngineError(`Сюжета №${storyId} нет`);
    return story;
  }

  async decide(
    storyId: number,
    action: DecisionAction,
    options: { reason?: string | null; instruction?: string | null; signal?: AbortSignal } = {},
  ): Promise<StoryRow> {
    const story = this.requireStory(storyId);
    if (action === "reject") {
      if (!this.store.transition(storyId, ["proposed", "candidate", "failed"], "rejected")) {
        throw new EngineError(`Сюжет №${storyId} уже нельзя отклонить (статус: ${story.status})`);
      }
      const updated = this.store.updateStory(storyId, { decided_at: nowIso(), decision_reason: options.reason ?? null });
      this.log("info", "decision", `Отклонено №${storyId}${options.reason ? `: ${options.reason}` : ""}`, storyId);
      await this.bot.afterDecision(updated);
      this.platform.changed();
      return updated;
    }
    if (action === "restore") {
      if (!this.store.transition(storyId, ["filtered", "rejected", "failed"], "candidate")) {
        throw new EngineError(`Сюжет №${storyId} нельзя вернуть (статус: ${story.status})`);
      }
      const updated = this.store.updateStory(storyId, {
        attempts: 0,
        last_error: null,
        decided_at: null,
        decision_reason: null,
        manual: 1,
        // The owner says it is worth a post of its own, so it no longer counts as a repeat.
        duplicate_of: null,
        proposal_chat_id: null,
        proposal_message_ids: null,
      });
      this.log("info", "decision", `Возвращено в работу №${storyId}`, storyId);
      this.pipelineWaker.kick();
      this.platform.changed();
      return updated;
    }
    if (action === "regenerate") {
      this.requestRewrite(storyId, options.instruction ?? null);
      return story;
    }
    return this.publish(storyId, options.signal);
  }

  /** Sets the reason on an already rejected story (the bot asks for it after the fact). */
  setRejectReason(storyId: number, reason: string): StoryRow {
    const story = this.requireStory(storyId);
    if (story.status !== "rejected") throw new EngineError("Причину можно указать только у отклонённого сюжета");
    const updated = this.store.updateStory(storyId, { decision_reason: reason });
    this.platform.changed();
    return updated;
  }

  /** Replaces the draft with the owner's own text. */
  async setDraft(storyId: number, html: string): Promise<StoryRow> {
    const story = this.requireStory(storyId);
    if (story.status !== "proposed") throw new EngineError("Править можно только предложение, которое ждёт решения");
    const clean = sanitizeTelegramHtml(html);
    const length = visibleLength(clean);
    if (length === 0) throw new EngineError("Текст пустой");
    if (length > MESSAGE_LIMIT) throw new EngineError(`Текст длиннее ${MESSAGE_LIMIT} знаков (${length})`);
    if (story.proposal_message_ids !== null) await this.bot.dropProposal(story);
    const updated = this.store.updateStory(storyId, {
      draft_html: clean,
      draft_version: story.draft_version + 1,
      draft_note: null,
      proposal_chat_id: null,
      proposal_message_ids: null,
    });
    this.pipelineWaker.kick();
    this.platform.changed();
    return updated;
  }

  private async publish(storyId: number, signal?: AbortSignal): Promise<StoryRow> {
    const config = await this.config();
    const api = this.api(config);
    if (api === null) throw new EngineError("Не задан токен бота: публиковать нечем");
    if (config.telegram.channel.trim() === "") throw new EngineError("Не задан канал для публикации");
    const channel = channelTarget(config.telegram.channel);
    if (channel === null) throw new EngineError(`Канал для публикаций указан неверно: «${config.telegram.channel}». Нужно @имя канала`);
    const before = this.requireStory(storyId);
    if (before.draft_html === null) throw new EngineError(`У сюжета №${storyId} нет черновика`);
    if (this.isRewriting(storyId)) throw new EngineError("Для этого сюжета готовится новый вариант, дождитесь его");
    if (!this.store.transition(storyId, ["proposed"], "publishing")) {
      throw new EngineError(`Сюжет №${storyId} нельзя опубликовать (статус: ${before.status})`);
    }
    try {
      let media = this.mediaFor(before);
      let sent;
      let note: string | null = null;
      try {
        sent = await sendPost(api, this.platform.fetch, channel, before.draft_html, media, signal);
      } catch (cause) {
        if (!(cause instanceof MediaError) || visibleLength(before.draft_html) > MESSAGE_LIMIT) throw cause;
        // The text is what matters; publish it and say that the media did not make it.
        media = [];
        note = `опубликовано без медиа: ${cause.message}`;
        sent = await sendPost(api, this.platform.fetch, channel, before.draft_html, [], signal);
      }
      const firstId = sent.messageIds[0] as number;
      const handle = this.ownHandle(config);
      const url = handle === null ? null : `https://t.me/${handle}/${firstId}`;
      const at = nowIso();
      for (const messageId of sent.messageIds) {
        this.store.addOwnPost(messageId, at, messageId === firstId ? before.draft_html : "", storyId);
      }
      const updated = this.store.updateStory(storyId, {
        status: "published",
        decided_at: at,
        published_at: at,
        published_url: url,
        last_error: note,
      });
      this.log("info", "decision", `Опубликовано №${storyId}${url === null ? "" : `: ${url}`}${note === null ? "" : ` (${note})`}`, storyId);
      await this.bot.afterDecision(updated);
      this.platform.changed();
      return updated;
    } catch (cause) {
      this.store.transition(storyId, ["publishing"], "proposed");
      const message =
        cause instanceof TelegramError && cause.code === 403
          ? `бот не может писать в ${channel}: сделайте его администратором канала с правом публикации`
          : cause instanceof TelegramError && cause.code === 400 && /chat not found/iu.test(cause.message)
            ? `канал ${channel} не найден: проверьте адрес и что бот добавлен в администраторы`
            : errorMessage(cause);
      this.store.updateStory(storyId, { last_error: `Не удалось опубликовать: ${message}` });
      this.log("error", "decision", `Не удалось опубликовать №${storyId}: ${message}`, storyId);
      this.platform.changed();
      throw new EngineError(`Не удалось опубликовать: ${message}`);
    }
  }

  // ---- material sent by hand -----------------------------------------------

  /**
   * Takes a post the owner sent or forwarded to the bot and puts it at the
   * front of the queue. Returns what happened so the bot can answer.
   */
  acceptManual(input: {
    sourceHandle: string;
    msgId: number;
    url: string;
    postedAt: string;
    text: string;
    links: string[];
    media: StoredMedia[];
    fingerprint: string;
  }): { kind: "queued"; storyId: number; similar: StoryRow | null } | { kind: "known"; story: StoryRow } {
    // The same message collected earlier, or the same text from anywhere.
    const sameMessage = this.store.getPostByRef(input.sourceHandle, input.msgId);
    const twin = sameMessage?.story_id != null ? sameMessage : this.store.findPostByFingerprint(input.fingerprint, -1);
    let knownStory = twin?.story_id == null ? undefined : this.store.getStory(twin.story_id);
    // A dropped repeat stands for the story it repeats.
    if (knownStory !== undefined && knownStory.duplicate_of !== null) {
      knownStory = this.store.getStory(knownStory.duplicate_of) ?? knownStory;
    }
    if (knownStory !== undefined) {
      if (knownStory.status !== "filtered" && knownStory.status !== "candidate" && knownStory.status !== "failed") {
        return { kind: "known", story: knownStory };
      }
      // The filter dropped it or it is still waiting: the owner wants it, so move it to the front.
      this.store.updateStory(knownStory.id, {
        status: "candidate",
        manual: 1,
        score: 100,
        reason: MANUAL_REASON,
        attempts: 0,
        last_error: null,
        duplicate_of: null,
      });
      this.log("info", "manual", `Сюжет №${knownStory.id} поднят в начало очереди по пересланному посту`, knownStory.id);
      this.pipelineWaker.kick();
      this.platform.changed();
      return { kind: "queued", storyId: knownStory.id, similar: null };
    }
    this.store.insertPost({
      source_id: null,
      source_handle: input.sourceHandle,
      msg_id: input.msgId,
      url: input.url,
      posted_at: input.postedAt,
      text: input.text,
      media_json: JSON.stringify(input.media),
      links_json: JSON.stringify(input.links),
      fwd_from: null,
      fingerprint: input.fingerprint,
    });
    const post = this.store.getPostByRef(input.sourceHandle, input.msgId) as PostRow;
    const tokens = contentTokens(input.text);
    const keys = linkKeys(input.links);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    let similar: StoryRow | null = null;
    let best = 0.6;
    for (const story of this.store.recentStories(since)) {
      if (story.status !== "own" && story.status !== "published") continue;
      const storyTokens = story.tokens === "" ? [] : story.tokens.split(" ");
      const shared = tokens.filter((token) => storyTokens.includes(token)).length;
      const similarity = Math.min(tokens.length, storyTokens.length) < 6 ? 0 : shared / Math.min(tokens.length, storyTokens.length);
      const sameLink = story.link_keys !== "" && story.link_keys.split(" ").some((key) => keys.includes(key));
      if (sameLink || similarity > best) {
        best = sameLink ? 1 : similarity;
        similar = story;
      }
    }
    const story = this.store.createStory({
      status: "candidate",
      title: truncate(firstSentence(input.text), 140),
      summary: truncate(input.text.replace(/\s+/gu, " "), 500),
      score: 100,
      reason: MANUAL_REASON,
      tokens,
      linkKeys: keys,
      manual: true,
    });
    this.store.settlePost(post.id, { state: "done", storyId: story.id });
    this.log("info", "manual", `Принят материал вручную, сюжет №${story.id}`, story.id);
    this.pipelineWaker.kick();
    this.platform.changed();
    return { kind: "queued", storyId: story.id, similar };
  }

  // ---- views ---------------------------------------------------------------

  storyView(story: StoryRow): StoryView {
    const posts = this.store.postsOfStory(story.id);
    return {
      id: story.id,
      status: story.status,
      title: story.title,
      summary: story.summary,
      score: story.score,
      reason: story.reason,
      draftHtml: story.draft_html,
      draftVersion: story.draft_version,
      draftNote: story.draft_note,
      manual: story.manual === 1,
      hasMedia: this.mediaFor(story).length > 0,
      rewriting: this.isRewriting(story.id),
      lastError: story.last_error,
      decisionReason: story.decision_reason,
      createdAt: story.created_at,
      decidedAt: story.decided_at,
      publishedAt: story.published_at,
      publishedUrl: story.published_url,
      sources: posts.map((post) => ({
        handle: post.source_handle,
        url: post.url,
        postedAt: post.posted_at,
        text: truncate(post.text, 1500),
        media: parseMedia(post.media_json).map((item) => ({
          kind: item.kind,
          sendable: item.fileId !== undefined || item.url !== null,
        })),
      })),
    };
  }

  listStories(filter: { statuses: StoryStatus[]; limit?: number; offset?: number; query?: string }): StoryView[] {
    return this.store
      .listStories({
        statuses: filter.statuses,
        limit: Math.min(filter.limit ?? 30, 100),
        offset: filter.offset ?? 0,
        query: filter.query,
      })
      .map((story) => this.storyView(story));
  }

  recentEvents(limit: number, minLevel: "info" | "warn" = "info"): EventRow[] {
    return this.store.recentEvents(limit, minLevel);
  }

  /** Saves what only the running copy knows, so `status` from another process can show it. */
  private saveRuntime(): void {
    this.store.setState("runtime", {
      at: Date.now(),
      botState: this.botState,
      botDetail: this.botDetail,
      botUsername: this.botUser?.username ?? null,
      channelProblem: this.channelProblem,
      pipelineLastError: this.pipelineLastError,
      pipelinePausedUntil: this.pipelinePausedUntil,
    });
  }

  /** This copy's own state while it runs the bot, else the last state saved by the copy that does. */
  private runtimeView(): {
    running: boolean | null;
    lastSeen: string | null;
    botState: BotState;
    botDetail: string | null;
    botUsername: string | null;
    channelProblem: string | null;
    pipelineLastError: string | null;
    pipelinePausedUntil: number;
  } {
    if (this.runsBot) {
      return {
        running: true,
        lastSeen: null,
        botState: this.botState,
        botDetail: this.botDetail,
        botUsername: this.botUser?.username ?? null,
        channelProblem: this.channelProblem,
        pipelineLastError: this.pipelineLastError,
        pipelinePausedUntil: this.pipelinePausedUntil,
      };
    }
    const saved = this.store.getState<{
      at: number;
      botState: BotState;
      botDetail: string | null;
      botUsername: string | null;
      channelProblem: string | null;
      pipelineLastError: string | null;
      pipelinePausedUntil: number;
    }>("runtime");
    if (saved === null) {
      return { running: null, lastSeen: null, botState: this.botState, botDetail: null, botUsername: null, channelProblem: null, pipelineLastError: null, pipelinePausedUntil: 0 };
    }
    // The running copy saves its state at least every half minute.
    const running = Date.now() - saved.at < 3 * 60_000;
    return { ...saved, running, lastSeen: new Date(saved.at).toISOString() };
  }

  async overview(backendName: string): Promise<Overview> {
    const config = await this.config();
    const sources = this.store.listSources();
    const runtime = this.runtimeView();
    const problems: string[] = [];
    const hasToken = config.telegram.botToken.trim() !== "";
    if (runtime.running === false && this.platform.runtime === "standalone") {
      problems.push(`Сервис сейчас не запущен (последний раз работал ${new Date(runtime.lastSeen as string).toLocaleString("ru-RU")}). Запустите start.bat или start.sh.`);
    }
    if (!hasToken) problems.push("Не задан токен бота (telegram.botToken): предложения некуда присылать, публиковать нечем.");
    else if (runtime.botState === "bad_token") problems.push("Telegram не принимает токен бота. Проверьте telegram.botToken: его выдаёт @BotFather.");
    else if (runtime.botState === "conflict") {
      problems.push("Этого бота уже опрашивает другая программа (вторая копия сервиса или старый скрипт). Оставьте одну.");
    } else if (runtime.botState === "error") {
      problems.push(`Нет связи с Telegram: ${runtime.botDetail ?? "ошибка"}.${this.platform.runtime === "standalone" ? " Если Telegram заблокирован, укажите network.proxy." : ""}`);
    }
    if (hasToken && runtime.botState !== "bad_token" && config.telegram.ownerChatId === null) {
      problems.push(`Бот не знает владельца. Отправьте ему: /start ${this.pairingCode()}`);
    }
    if (hasToken && runtime.channelProblem !== null) problems.push(runtime.channelProblem);
    if (sources.length === 0) problems.push("Список источников пуст. Добавьте каналы.");
    const failing = sources.filter((row) => row.enabled === 1 && row.error_count >= 3);
    for (const row of failing.slice(0, 5)) problems.push(`Источник @${row.handle} не читается: ${row.last_error ?? "ошибка"}`);
    if (runtime.pipelineLastError !== null) problems.push(`Модель: ${runtime.pipelineLastError}`);
    const failedStories = this.store.countByStatus().failed ?? 0;
    if (failedStories > 0) problems.push(`Не удалось подготовить черновиков: ${failedStories}. Посмотреть: queue failed; вернуть в работу: restore <номер>.`);
    return {
      runtime: this.platform.runtime,
      counts: this.store.countByStatus(),
      newPosts: this.store.countNewPosts(),
      sources: {
        total: sources.length,
        enabled: sources.filter((row) => row.enabled === 1).length,
        failing: failing.length,
      },
      collector: {
        enabled: config.schedule.collectEnabled,
        lastRunAt: this.store.getState<string>("collector_last_run"),
        pollMinutes: config.schedule.pollMinutes,
      },
      pipeline: {
        enabled: config.schedule.pipelineEnabled,
        lastError: runtime.pipelineLastError,
        pausedUntil: runtime.pipelinePausedUntil > Date.now() ? new Date(runtime.pipelinePausedUntil).toISOString() : null,
      },
      bot: { state: runtime.botState, username: runtime.botUsername, detail: runtime.botDetail },
      owner: {
        paired: config.telegram.ownerChatId !== null,
        pairingCode: config.telegram.ownerChatId === null ? this.pairingCode() : null,
      },
      channel: config.telegram.channel,
      ownPosts: this.store.countOwnPosts(),
      llm: { backend: backendName, stats: this.store.llmStats(new Date(Date.now() - 86_400_000).toISOString()) },
      problems,
    };
  }

  // ---- logging and alerts ----------------------------------------------------

  log(level: EventRow["level"], kind: string, message: string, storyId: number | null = null): void {
    this.store.logEvent(level, kind, message, storyId);
    this.platform.log(level, message);
  }

  /** Sends the owner a message about one specific event (no throttling, unlike alertOwner). */
  private async notifyOwner(html: string): Promise<void> {
    try {
      const config = await this.config();
      const api = this.api(config);
      if (api === null || config.telegram.ownerChatId === null) return;
      await api.sendText(config.telegram.ownerChatId, html, { disablePreview: true });
    } catch {
      // Best effort: the event log has it too.
    }
  }

  /** Tells the owner in Telegram that something needs attention; at most once in ten minutes. */
  async alertOwner(html: string): Promise<void> {
    if (Date.now() - this.lastOwnerAlertAt < 10 * 60_000) return;
    try {
      const config = await this.config();
      const api = this.api(config);
      if (api === null || config.telegram.ownerChatId === null) return;
      this.lastOwnerAlertAt = Date.now();
      await api.sendText(config.telegram.ownerChatId, `⚠️ ${html}`, { disablePreview: true });
    } catch {
      // The alert is best effort; the problem is already in the event log.
    }
  }

  kickPipeline(): void {
    this.pipelineWaker.kick();
  }

  kickCollector(): void {
    this.collectorWaker.kick();
  }

  // ---- loops -----------------------------------------------------------------

  async runCollector(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let pollMinutes = 3;
      try {
        const config = await this.config();
        pollMinutes = config.schedule.pollMinutes;
        if (config.schedule.collectEnabled) await this.collectOnce(signal);
      } catch (cause) {
        if (signal.aborted) return;
        this.log("error", "collector", `Сбор прерван ошибкой: ${errorMessage(cause)}`);
      }
      await this.collectorWaker.wait(pollMinutes * 60_000, signal);
    }
  }

  async runPipeline(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.pipelineStep(signal);
      } catch (cause) {
        if (signal.aborted) return;
        this.log("error", "pipeline", `Сбой конвейера: ${errorMessage(cause)}`);
      }
      if (!worked) await this.pipelineWaker.wait(20_000, signal);
    }
  }

  /** Moves proposals nobody decided on in time to the filtered list, where they can still be restored. */
  async expireStaleProposals(): Promise<number> {
    const config = await this.config();
    const hours = config.editorial.proposalTtlHours;
    const cutoff = Date.now() - hours * 3_600_000;
    let expired = 0;
    for (const story of this.store.listStories({ statuses: ["proposed"], limit: 100, offset: 0 })) {
      if (new Date(story.updated_at).getTime() > cutoff || this.isRewriting(story.id)) continue;
      if (!this.store.transition(story.id, ["proposed"], "filtered")) continue;
      this.store.updateStory(story.id, { reason: `не рассмотрено за ${hours} ч${story.reason ? `; было: ${story.reason}` : ""}` });
      await this.bot.afterExpiry(story, hours);
      expired += 1;
    }
    if (expired > 0) {
      this.log("info", "expire", `Срок истёк у предложений: ${expired}. Они перенесены в отсев.`);
      this.platform.changed();
    }
    return expired;
  }

  async runMaintenance(signal: AbortSignal): Promise<void> {
    let lastPruneAt = 0;
    while (!signal.aborted) {
      try {
        // The first pass reads more history, so the memory of the channel starts out useful.
        const firstRun = this.store.countOwnPosts() === 0;
        await this.refreshOwnChannel(signal, firstRun ? 8 : 1);
        this.ownChannelLoaded = true;
        this.lastOwnError = null;
      } catch (cause) {
        if (signal.aborted) return;
        this.reportOwnChannelError(cause);
      }
      await this.expireStaleProposals().catch((cause: unknown) => {
        this.log("warn", "expire", `Не удалось разобрать просроченные предложения: ${errorMessage(cause)}`);
      });
      if (Date.now() - lastPruneAt > 86_400_000) {
        this.store.prune(new Date(Date.now() - 30 * 86_400_000).toISOString());
        lastPruneAt = Date.now();
      }
      await sleep(15 * 60_000, signal);
    }
  }

  async runBot(signal: AbortSignal): Promise<void> {
    let activeToken = "";
    let offset = 0;
    let savedAt = 0;
    this.runsBot = true;
    while (!signal.aborted) {
      if (Date.now() - savedAt > 30_000) {
        this.saveRuntime();
        savedAt = Date.now();
      }
      const config = await this.config().catch(() => null);
      const token = config?.telegram.botToken.trim() ?? "";
      if (config === null || token === "") {
        this.botState = "off";
        this.botDetail = null;
        this.botUser = null;
        activeToken = "";
        await sleep(10_000, signal);
        continue;
      }
      const api = this.api(config) as TelegramApi;
      try {
        if (token !== activeToken) {
          this.botState = "starting";
          this.botUser = await api.getMe({ signal });
          activeToken = token;
          // The command menu in Telegram; failing to set it changes nothing else.
          await api.call("setMyCommands", { commands: BOT_COMMANDS }, { signal }).catch(() => undefined);
          offset = this.store.getState<number>(`bot_offset:${this.botUser.id}`) ?? 0;
          this.platform.changed();
        }
        await this.checkChannelAccess(api, config, (this.botUser as TgUser).id, signal);
        const updates = await api.getUpdates(offset, 25, { signal });
        if (this.botState !== "ok") {
          this.botState = "ok";
          this.botDetail = null;
          this.saveRuntime();
          savedAt = Date.now();
          this.platform.changed();
        }
        for (const update of updates) {
          offset = update.update_id + 1;
          this.store.setState(`bot_offset:${(this.botUser as TgUser).id}`, offset);
          try {
            await this.bot.handleUpdate(api, config, update, signal);
          } catch (cause) {
            if (signal.aborted) return;
            this.log("error", "bot", `Ошибка при обработке сообщения: ${errorMessage(cause)}`);
          }
        }
      } catch (cause) {
        if (signal.aborted) return;
        const code = cause instanceof TelegramError ? cause.code : 0;
        const previous = this.botState;
        this.botState = code === 401 || code === 404 ? "bad_token" : code === 409 ? "conflict" : "error";
        this.botDetail = errorMessage(cause);
        if (this.botState !== previous) {
          const advice =
            this.botState === "bad_token"
              ? `Telegram не принимает токен бота (${this.botDetail}). Проверьте telegram.botToken: его выдаёт @BotFather.`
              : this.botState === "conflict"
                ? "Этого бота уже опрашивает другая программа (вторая копия сервиса или старый скрипт). Оставьте одну."
                : `Нет связи с Telegram: ${this.botDetail}.${this.platform.runtime === "standalone" ? " Если Telegram заблокирован, укажите network.proxy." : ""}`;
          this.log("warn", "bot", `Бот: ${advice}`);
          this.saveRuntime();
          savedAt = Date.now();
          this.platform.changed();
        }
        if (this.botState === "bad_token") activeToken = "";
        await sleep(this.botState === "error" ? 5_000 : 30_000, signal);
      }
    }
    this.runsBot = false;
    this.bot.dispose();
  }
}
