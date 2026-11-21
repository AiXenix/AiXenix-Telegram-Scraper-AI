// bb-plugin-newsdesk — the bb shell around the engine in src/. It supplies
// storage, settings, the model runner on bb subscriptions, the admin page's
// RPC, the `bb newsdesk` command and the HTTP routes the standalone script
// uses to borrow the same model runner.
import { randomUUID } from "node:crypto";
import { PluginCliError, cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_CONFIG,
  SECRET_PATHS,
  applyConfigEdit,
  redactConfig,
  resolveBackend,
  resolveConfig,
  type Config,
} from "./src/config.ts";
import { MIGRATIONS, Store, type EventRow, type StoryStatus } from "./src/db.ts";
import {
  Engine,
  EngineError,
  type Overview,
  type SourceView,
  type StoryView,
} from "./src/engine.ts";
import { createOpenAiLlm } from "./src/llm/openai.ts";
import { NO_TOOLS_PREAMBLE } from "./src/llm/shared.ts";
import { createThreadLlm, pruneWorkerThreads, stopStrayWorkerThreads } from "./src/llm/threads.ts";
import { errorMessage, type ConfigStore, type LlmRequest, type LlmRunner, type Platform } from "./src/platform.ts";

export type { Config, EventRow, Overview, SourceView, StoryView, StoryStatus };

const STATUSES = ["candidate", "proposed", "publishing", "published", "rejected", "filtered", "own", "failed"] as const;

/** Output schemas only assert "this is JSON we built ourselves"; the types carry the shape to app.tsx. */
const out = <T>() => z.custom<T>(() => true);

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: out<Overview>() },
  events: {
    input: z.object({ limit: z.number().int().min(1).max(200), problemsOnly: z.boolean().optional() }).strict(),
    output: out<{ events: EventRow[] }>(),
  },
  sources_list: { input: z.null(), output: out<{ sources: SourceView[] }>() },
  source_add: {
    input: z.object({ input: z.string().trim().min(1).max(200) }).strict(),
    output: out<{ handle: string; title: string | null }>(),
  },
  source_remove: { input: z.object({ handle: z.string() }).strict(), output: out<{ ok: true }>() },
  source_set_enabled: {
    input: z.object({ handle: z.string(), enabled: z.boolean() }).strict(),
    output: out<{ ok: true }>(),
  },
  collect_now: { input: z.null(), output: out<{ ok: true }>() },
  stories_list: {
    input: z
      .object({
        statuses: z.array(z.enum(STATUSES)).min(1),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        query: z.string().max(200).optional(),
      })
      .strict(),
    output: out<{ stories: StoryView[] }>(),
  },
  story_decide: {
    input: z
      .object({
        id: z.number().int(),
        action: z.enum(["publish", "reject", "regenerate", "restore"]),
        reason: z.string().max(200).nullable().optional(),
        instruction: z.string().max(1000).nullable().optional(),
      })
      .strict(),
    output: out<{ story: StoryView }>(),
  },
  story_set_draft: {
    input: z.object({ id: z.number().int(), html: z.string().min(1).max(20_000) }).strict(),
    output: out<{ story: StoryView }>(),
  },
  config_get: { input: z.null(), output: out<{ config: Config }>() },
  config_set: { input: z.object({ config: z.unknown() }).strict(), output: out<{ config: Config }>() },
  own_refresh: { input: z.object({ pages: z.number().int().min(1).max(30) }).strict(), output: out<{ added: number }>() },
  reset_from_now: { input: z.null(), output: out<{ stories: number; posts: number; sources: number; messages: number }>() },
  llm_test: {
    input: z.object({ which: z.enum(["filter", "writer"]) }).strict(),
    output: out<{ ok: boolean; ms: number; model: string; text: string }>(),
  },
});

/** Realtime channel the admin page listens on. */
export const CHANGED_CHANNEL = "changed";

const SECRET_SETTING: Record<string, "botToken" | "llmBbToken" | "llmApiKey"> = {
  "telegram.botToken": "botToken",
  "llm.bbToken": "llmBbToken",
  "llm.apiKey": "llmApiKey",
};

interface LlmJob {
  status: "running" | "done" | "error";
  text?: string;
  error?: string;
  finishedAt?: number;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);

  const settings = bb.settings.define({
    botToken: { type: "string", label: "Токен Telegram-бота (@BotFather)", secret: true },
    llmApiKey: { type: "string", label: "Ключ API модели (только для llm.backend = openai)", secret: true },
    llmBbToken: { type: "string", label: "Токен плагина на другом сервере bb (только для llm.backend = bb-remote)", secret: true },
  });

  // ---- config: non-secret part in kv, secrets in bb's secret settings ------

  let cached: Config | null = null;
  const configStore: ConfigStore = {
    async load() {
      if (cached !== null) return cached;
      const stored = await bb.storage.kv.get<unknown>("config");
      const secrets = await settings.get();
      const base = resolveConfig(stored ?? {});
      base.telegram.botToken = typeof secrets.botToken === "string" ? secrets.botToken : "";
      base.llm.bbToken = typeof secrets.llmBbToken === "string" ? secrets.llmBbToken : "";
      base.llm.apiKey = typeof secrets.llmApiKey === "string" ? secrets.llmApiKey : "";
      cached = base;
      return base;
    },
    async save(next) {
      const plain = structuredClone(next) as Config;
      const secretPatch: Record<string, string | null> = {};
      for (const [section, key] of SECRET_PATHS) {
        const holder = plain[section] as Record<string, unknown>;
        const value = typeof holder[key] === "string" ? (holder[key] as string) : "";
        secretPatch[SECRET_SETTING[`${section}.${key}`] as string] = value === "" ? null : value;
        holder[key] = "";
      }
      await bb.storage.kv.set("config", plain);
      await settings.experimental_set(secretPatch);
      cached = null;
    },
  };
  settings.onChange(() => {
    cached = null;
  });

  // ---- platform --------------------------------------------------------------

  let changedTimer: ReturnType<typeof setTimeout> | null = null;
  const platform: Platform = {
    runtime: "bb",
    fetch: (input, init) => fetch(input, init),
    log(level, message) {
      bb.log[level](message);
    },
    changed() {
      if (changedTimer !== null) return;
      changedTimer = setTimeout(() => {
        changedTimer = null;
        bb.realtime.publish(CHANGED_CHANNEL, { at: Date.now() });
      }, 250);
    },
  };
  bb.onDispose(() => {
    if (changedTimer !== null) clearTimeout(changedTimer);
  });

  // ---- model runner ------------------------------------------------------------

  const resolveProjectId = async () => {
    const config = await configStore.load();
    if (config.llm.workerProjectId !== null) return config.llm.workerProjectId;
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find((project) => project.kind === "personal");
    if (personal === undefined) throw new Error("Не найден личный проект bb для запуска моделей");
    return personal.id;
  };
  const threadLlm = createThreadLlm(bb, store, resolveProjectId);
  const llm: LlmRunner = {
    async run(request: LlmRequest) {
      const config = await configStore.load();
      const backend = resolveBackend(config, "bb");
      if (backend === "openai") {
        return createOpenAiLlm({ apiBaseUrl: config.llm.apiBaseUrl, apiKey: config.llm.apiKey, fetch: platform.fetch }).run(request);
      }
      // "bb-remote" inside bb means "this very server": run it locally.
      return threadLlm.run(request);
    },
  };

  const engine = new Engine({ store, platform, configStore, llm });
  const backendName = async () => resolveBackend(await configStore.load(), "bb");

  // ---- background work ---------------------------------------------------------

  bb.background.service("collector", { start: (signal) => engine.runCollector(signal) });
  // Worker threads cut off by the previous reload or a crash would otherwise stay running.
  void stopStrayWorkerThreads(bb).then(
    (stopped) => {
      if (stopped > 0) bb.log.info(`stopped ${stopped} stray model threads from the previous run`);
    },
    () => undefined,
  );
  bb.background.service("pipeline", { start: (signal) => engine.runPipeline(signal) });
  bb.background.service("bot", { start: (signal) => engine.runBot(signal) });
  bb.background.service("maintenance", { start: (signal) => engine.runMaintenance(signal) });
  bb.background.schedule("prune-threads", "17 4 * * *", async () => {
    const removed = await pruneWorkerThreads(bb, 2 * 86_400_000);
    if (removed > 0) bb.log.info(`pruned ${removed} finished model threads`);
  });

  // ---- model runner for the standalone script (token-authenticated HTTP) --------

  const jobs = new Map<string, LlmJob>();
  const jobController = new AbortController();
  bb.onDispose(() => jobController.abort());
  const llmRequestSchema = z
    .object({
      task: z.string().min(1).max(60),
      model: z.string().min(1).max(80),
      reasoning: z.string().min(1).max(20),
      prompt: z.string().min(1).max(400_000),
    })
    .strict();
  bb.http.route(
    "POST",
    "/llm",
    async (context) => {
      const parsed = llmRequestSchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return context.json({ error: "bad request" }, 400);
      for (const [id, job] of jobs) {
        if (job.finishedAt !== undefined && Date.now() - job.finishedAt > 15 * 60_000) jobs.delete(id);
      }
      if ([...jobs.values()].filter((job) => job.status === "running").length >= 4) {
        return context.json({ error: "too many model requests in flight" }, 429);
      }
      const jobId = randomUUID();
      jobs.set(jobId, { status: "running" });
      threadLlm
        .run({ ...parsed.data, task: `удалённо: ${parsed.data.task}`, signal: jobController.signal })
        .then(
          (text) => jobs.set(jobId, { status: "done", text, finishedAt: Date.now() }),
          (cause: unknown) => jobs.set(jobId, { status: "error", error: errorMessage(cause), finishedAt: Date.now() }),
        );
      return context.json({ jobId }, 202);
    },
    { auth: "token" },
  );
  bb.http.route(
    "GET",
    "/llm-result",
    (context) => {
      const job = jobs.get(context.req.query("job") ?? "");
      if (job === undefined) return context.json({ status: "unknown" });
      return context.json({ status: job.status, text: job.text, error: job.error });
    },
    { auth: "token" },
  );
  bb.http.route("GET", "/health", (context) => context.json({ ok: true, plugin: bb.pluginId }), { auth: "token" });

  const resetController = new AbortController();
  bb.onDispose(() => resetController.abort());

  // ---- RPC for the admin page ----------------------------------------------------

  const refuse = (cause: unknown): never => {
    // Expected refusals (bad input, wrong state) reach the page as readable messages.
    throw cause instanceof EngineError ? new Error(cause.message) : cause;
  };
  const testModel = async (which: "filter" | "writer", signal: AbortSignal) => {
    const config = await configStore.load();
    const model = which === "filter" ? config.llm.filterModel : config.llm.writerModel;
    const startedAt = Date.now();
    try {
      const text = await llm.run({
        task: "проверка",
        model,
        reasoning: "low",
        prompt: `${NO_TOOLS_PREAMBLE}\n\nВерни JSON-объект {"ok": true, "sum": <сумма 17 и 25>} и больше ничего.`,
        signal,
        timeoutMs: 4 * 60_000,
      });
      return { ok: true, ms: Date.now() - startedAt, model, text: text.trim().slice(0, 300) };
    } catch (cause) {
      return { ok: false, ms: Date.now() - startedAt, model, text: errorMessage(cause) };
    }
  };

  bb.rpc.register(rpcContract, {
    overview: async () => engine.overview(await backendName()),
    events: ({ limit, problemsOnly }) => ({ events: engine.recentEvents(limit, problemsOnly === true ? "warn" : "info") }),
    sources_list: () => ({ sources: engine.listSources() }),
    source_add: ({ input }) => engine.addSource(input).catch(refuse),
    source_remove: async ({ handle }) => {
      await engine.removeSource(handle).catch(refuse);
      return { ok: true as const };
    },
    source_set_enabled: async ({ handle, enabled }) => {
      await engine.setSourceEnabled(handle, enabled).catch(refuse);
      return { ok: true as const };
    },
    collect_now: () => {
      engine.kickCollector();
      return { ok: true as const };
    },
    stories_list: ({ statuses, limit, offset, query }) => ({ stories: engine.listStories({ statuses, limit, offset, query }) }),
    story_decide: async ({ id, action, reason, instruction }) => {
      if (action === "publish") {
        // Uploading media can take a while; publish in the background and let
        // the page follow the status. A failure lands in the story's lastError.
        const story = engine.requireStory(id);
        if (story.status !== "proposed") refuse(new EngineError(`Сюжет №${id} нельзя опубликовать (статус: ${story.status})`));
        void engine.decide(id, "publish").catch(() => undefined);
        return { story: engine.storyView(engine.requireStory(id)) };
      }
      const story = await engine.decide(id, action, { reason, instruction }).catch(refuse);
      return { story: engine.storyView(story) };
    },
    story_set_draft: async ({ id, html }) => ({ story: engine.storyView(await engine.setDraft(id, html).catch(refuse)) }),
    config_get: async () => ({ config: redactConfig(await configStore.load()) }),
    config_set: async ({ config }) => {
      const current = await configStore.load();
      const next = applyConfigEdit(current, config);
      await configStore.save(next);
      await engine.syncSources().catch(() => undefined);
      engine.kickCollector();
      platform.changed();
      return { config: redactConfig(next) };
    },
    own_refresh: async ({ pages }, context) => ({
      added: await engine.refreshOwnChannel(context.experimental_signal ?? new AbortController().signal, pages),
    }),
    llm_test: ({ which }, context) => testModel(which, context.experimental_signal ?? new AbortController().signal),
    // Not tied to the caller's connection: a reset that started must finish.
    reset_from_now: () => engine.resetFromNow(resetController.signal),
  });

  // ---- `bb newsdesk` ---------------------------------------------------------------

  const fail = (cause: unknown): never => {
    throw new PluginCliError(errorMessage(cause), { code: cause instanceof EngineError ? "refused" : "failed" });
  };
  const storyLine = (story: StoryView) =>
    `№${story.id}  [${story.status}]${story.score === null ? "" : `  оценка ${story.score}`}  ${story.title}`;
  const parseId = (raw: string): number => {
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id)) throw new PluginCliError(`"${raw}" не похоже на номер сюжета`, { code: "bad_id" });
    return id;
  };
  const jsonOption = { json: { type: "boolean", description: "Вывести JSON" } } as const;

  bb.cli.register(
    defineCli({
      name: "newsdesk",
      summary: "Редакция новостей: источники, очередь предложений, публикация в Telegram-канал",
      commands: {
        status: cliCommand({
          summary: "Состояние сервиса: сбор, бот, очередь, проблемы",
          options: jsonOption,
          async run(input) {
            const overview = await engine.overview(await backendName());
            if (input.options.json === true) return { exitCode: 0, stdout: JSON.stringify(overview) };
            const counts = overview.counts;
            const lines = [
              `Канал: ${overview.channel}   модели: ${overview.llm.backend}`,
              `Источники: ${overview.sources.enabled} из ${overview.sources.total}, не читается: ${overview.sources.failing}`,
              `Сбор: ${overview.collector.enabled ? "включён" : "выключен"}, последний: ${overview.collector.lastRunAt ?? "ещё не было"}`,
              `Бот: ${overview.bot.state}${overview.bot.username === null ? "" : ` @${overview.bot.username}`}, владелец: ${overview.owner.paired ? "привязан" : `не привязан, код ${overview.owner.pairingCode}`}`,
              `Ждут разбора: ${overview.newPosts}, черновика: ${counts.candidate ?? 0}, решения: ${counts.proposed ?? 0}`,
              `Опубликовано: ${counts.published ?? 0}, отклонено: ${counts.rejected ?? 0}, отсеяно: ${counts.filtered ?? 0}, своих постов в памяти: ${overview.ownPosts}`,
              ...overview.problems.map((problem) => `! ${problem}`),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        sources: cliCommand({
          summary: "Список каналов-источников",
          options: jsonOption,
          async run(input) {
            const sources = engine.listSources();
            if (input.options.json === true) return { exitCode: 0, stdout: JSON.stringify(sources) };
            if (sources.length === 0) return { exitCode: 0, stdout: "Список пуст. Добавить: bb newsdesk source add @канал" };
            return {
              exitCode: 0,
              stdout: sources
                .map(
                  (source) =>
                    `@${source.handle}  ${source.enabled ? "вкл" : "пауза"}  постов ${source.posts}, опубл. ${source.published}, откл. ${source.rejected}${source.lastError === null ? "" : `  ОШИБКА: ${source.lastError}`}`,
                )
                .join("\n"),
            };
          },
        }),
        "source add": cliCommand({
          summary: "Добавить канал: @name или ссылка t.me/name (можно несколько)",
          positionals: [{ name: "channels", description: "Каналы", required: true, variadic: true }],
          async run(input) {
            const lines: string[] = [];
            let failed = false;
            for (const item of input.positionals.channels as string[]) {
              try {
                const source = await engine.addSource(item);
                lines.push(`Добавлен @${source.handle}${source.title === null ? "" : ` (${source.title})`}`);
              } catch (cause) {
                failed = true;
                lines.push(`${item}: ${errorMessage(cause)}`);
              }
            }
            return { exitCode: failed ? 1 : 0, stdout: lines.join("\n") };
          },
        }),
        "source remove": cliCommand({
          summary: "Убрать канал из списка",
          positionals: [{ name: "channel", description: "Канал", required: true }],
          async run(input) {
            await engine.removeSource(input.positionals.channel as string).catch(fail);
            return { exitCode: 0, stdout: "Убран" };
          },
        }),
        "source pause": cliCommand({
          summary: "Приостановить канал",
          positionals: [{ name: "channel", description: "Канал", required: true }],
          async run(input) {
            await engine.setSourceEnabled(input.positionals.channel as string, false).catch(fail);
            return { exitCode: 0, stdout: "На паузе" };
          },
        }),
        "source resume": cliCommand({
          summary: "Вернуть канал с паузы",
          positionals: [{ name: "channel", description: "Канал", required: true }],
          async run(input) {
            await engine.setSourceEnabled(input.positionals.channel as string, true).catch(fail);
            return { exitCode: 0, stdout: "Включён" };
          },
        }),
        collect: cliCommand({
          summary: "Проверить каналы сейчас и показать, сколько постов собрано",
          async run(_input, ctx) {
            const results = await engine.collectOnce(ctx.signal ?? new AbortController().signal).catch(fail);
            return {
              exitCode: 0,
              stdout:
                results.length === 0
                  ? "Нет включённых источников"
                  : results.map((result) => `@${result.handle}: ${result.error ?? `новых постов ${result.stored}`}`).join("\n"),
            };
          },
        }),
        queue: cliCommand({
          summary: "Сюжеты по статусу (по умолчанию ждут решения)",
          options: {
            status: {
              type: "enum",
              values: [...STATUSES],
              default: "proposed",
              description: "Статус: proposed, candidate, published, rejected, filtered, own, failed",
            },
            limit: { type: "integer", default: 20, min: 1, max: 100, description: "Сколько показать, от 1 до 100" },
            ...jsonOption,
          },
          async run(input) {
            const stories = engine.listStories({
              statuses: [input.options.status as StoryStatus],
              limit: Number(input.options.limit),
            });
            if (input.options.json === true) return { exitCode: 0, stdout: JSON.stringify(stories) };
            return { exitCode: 0, stdout: stories.length === 0 ? "Пусто" : stories.map(storyLine).join("\n") };
          },
        }),
        show: cliCommand({
          summary: "Показать сюжет: черновик, источники, заметки",
          positionals: [{ name: "id", description: "Номер сюжета", required: true }],
          options: jsonOption,
          async run(input) {
            const view = engine.storyView(engine.requireStory(parseId(input.positionals.id as string)));
            if (input.options.json === true) return { exitCode: 0, stdout: JSON.stringify(view) };
            const lines = [
              storyLine(view),
              view.reason === null ? "" : `Почему: ${view.reason}`,
              view.draftNote === null ? "" : `Заметка: ${view.draftNote}`,
              view.lastError === null ? "" : `Ошибка: ${view.lastError}`,
              view.publishedUrl === null ? "" : `Опубликовано: ${view.publishedUrl}`,
              "",
              view.draftHtml === null ? "(черновика ещё нет)" : `--- черновик, вариант ${view.draftVersion}${view.hasMedia ? ", с медиа" : ""} ---\n${view.draftHtml}`,
              "",
              ...view.sources.map((source) => `--- источник @${source.handle} ${source.url}\n${source.text}`),
            ];
            return { exitCode: 0, stdout: lines.filter((line, index) => line !== "" || index > 4).join("\n") };
          },
        }),
        publish: cliCommand({
          summary: "Опубликовать предложение в канал",
          positionals: [{ name: "id", description: "Номер сюжета", required: true }],
          async run(input, ctx) {
            const story = await engine.decide(parseId(input.positionals.id as string), "publish", { signal: ctx.signal }).catch(fail);
            return { exitCode: 0, stdout: `Опубликовано: ${story.published_url ?? "(без ссылки)"}` };
          },
        }),
        reject: cliCommand({
          summary: "Отклонить предложение",
          positionals: [{ name: "id", description: "Номер сюжета", required: true }],
          options: { reason: { type: "string", description: "Причина, до 200 знаков" } },
          async run(input) {
            const reason = typeof input.options.reason === "string" ? input.options.reason.slice(0, 200) : null;
            await engine.decide(parseId(input.positionals.id as string), "reject", { reason }).catch(fail);
            return { exitCode: 0, stdout: "Отклонено" };
          },
        }),
        regenerate: cliCommand({
          summary: "Попросить другой вариант черновика (готовится в фоне)",
          positionals: [{ name: "id", description: "Номер сюжета", required: true }],
          options: { instruction: { type: "string", description: "Что изменить, до 1000 знаков" } },
          async run(input) {
            const instruction = typeof input.options.instruction === "string" ? input.options.instruction.slice(0, 1000) : null;
            await engine.decide(parseId(input.positionals.id as string), "regenerate", { instruction }).catch(fail);
            return { exitCode: 0, stdout: "Готовлю новый вариант" };
          },
        }),
        restore: cliCommand({
          summary: "Вернуть отсеянный или отклонённый сюжет в работу",
          positionals: [{ name: "id", description: "Номер сюжета", required: true }],
          async run(input) {
            await engine.decide(parseId(input.positionals.id as string), "restore").catch(fail);
            return { exitCode: 0, stdout: "Возвращён, черновик будет готов через минуту-две" };
          },
        }),
        reset: cliCommand({
          summary: "Начать с чистого листа: забыть собранные посты, предложения и отсев, следить с текущего момента",
          options: { yes: { type: "boolean", description: "Подтверждение: без него команда ничего не делает" } },
          async run(input) {
            if (input.options.yes !== true) {
              throw new PluginCliError("Сброс удаляет все собранные посты, предложения и отсев. Подтвердите: bb newsdesk reset --yes", {
                code: "confirmation_required",
              });
            }
            const result = await engine.resetFromNow(resetController.signal).catch(fail);
            return {
              exitCode: 0,
              stdout: `Сброшено: сюжетов ${result.stories}, постов ${result.posts}, сообщений убрано из Telegram ${result.messages}. Каналов с новой точки отсчёта: ${result.sources}.`,
            };
          },
        }),
        "config export": cliCommand({
          summary: "Вывести настройки одним JSON (тот же файл подходит отдельному скрипту)",
          options: { "with-secrets": { type: "boolean", description: "Включить токены и ключи открытым текстом" } },
          async run(input) {
            const config = await configStore.load();
            return {
              exitCode: 0,
              stdout: JSON.stringify(input.options["with-secrets"] === true ? config : redactConfig(config), null, 2),
            };
          },
        }),
        "config import": cliCommand({
          summary: "Загрузить настройки из JSON-файла на сервере bb",
          positionals: [{ name: "path", description: "Абсолютный путь к файлу на сервере bb", required: true }],
          async run(input) {
            const file = await bb.sdk.files.read({ path: input.positionals.path as string }).catch(fail);
            const raw = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              throw new PluginCliError("Файл не является JSON", { code: "bad_json" });
            }
            const current = await configStore.load();
            // The file replaces the config; values it omits fall back to defaults, masked secrets keep their value.
            const next = applyConfigEdit({ ...DEFAULT_CONFIG, telegram: current.telegram, llm: current.llm }, parsed);
            await configStore.save(next).catch(fail);
            await engine.syncSources().catch(() => undefined);
            engine.kickCollector();
            platform.changed();
            return { exitCode: 0, stdout: `Настройки загружены. Источников: ${next.sources.length}` };
          },
        }),
        "llm-test": cliCommand({
          summary: "Проверить, что модели отвечают",
          options: {
            which: { type: "enum", values: ["filter", "writer"], default: "filter", description: "Какую модель проверить" },
          },
          async run(input, ctx) {
            const result = await testModel(input.options.which as "filter" | "writer", ctx.signal ?? new AbortController().signal);
            return {
              exitCode: result.ok ? 0 : 1,
              stdout: `${result.model}: ${result.ok ? "отвечает" : "ОШИБКА"} за ${result.ms} мс\n${result.text}`,
            };
          },
        }),
      },
    }),
  );

  bb.log.info("newsdesk loaded");
}
