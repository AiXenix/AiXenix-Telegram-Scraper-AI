// Standalone entry: the same engine as the bb plugin, run as a plain Node.js
// script. State lives in a SQLite file next to the config; settings come from
// one JSON file (the same document the plugin exports).
//
//   node newsdesk.mjs run            start the service and keep it running
//   node newsdesk.mjs status         show what is going on
//   node newsdesk.mjs help           list every command
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import {
  ConfigError,
  DEFAULT_CONFIG,
  configWarnings,
  deepMerge,
  redactConfig,
  resolveBackend,
  resolveConfig,
  type Config,
} from "../src/config.ts";
import { Store, migrate, type StoryStatus } from "../src/db.ts";
import { Engine, EngineError, type StoryView } from "../src/engine.ts";
import { createOpenAiLlm } from "../src/llm/openai.ts";
import { createRemoteLlm } from "../src/llm/remote.ts";
import { NO_TOOLS_PREAMBLE } from "../src/llm/shared.ts";
import { errorMessage, sleep, type ConfigStore, type LlmRequest, type LlmRunner, type Platform } from "../src/platform.ts";
import { channelTarget } from "../src/tme.ts";
import { EXAMPLE_OVERRIDES, PLACEHOLDER_PATTERN } from "./example-config.ts";

const STATUSES: StoryStatus[] = ["candidate", "proposed", "publishing", "published", "rejected", "filtered", "own", "failed"];

const HELP = `Редакция новостей — отдельный запуск.

Использование: node newsdesk.mjs <команда> [--config путь] [параметры]

  run                           запустить сервис (сбор, отбор, бот) и держать его работающим
  status                        состояние: источники, очередь, бот, проблемы
  sources                       список каналов
  add <канал...>                добавить каналы (@name или ссылка t.me/name)
  remove <канал>                убрать канал
  pause <канал> | resume <канал>  приостановить и вернуть канал
  collect                       проверить каналы сейчас
  queue [статус]                сюжеты по статусу (по умолчанию proposed)
  show <номер>                  черновик и источники сюжета
  publish <номер>               опубликовать в канал
  reject <номер> [причина]      отклонить
  regenerate <номер> [указание] другой вариант черновика
  restore <номер>               вернуть отсеянный, отклонённый или неудавшийся сюжет в работу
  reset --yes                   начать с чистого листа: забыть всё собранное, следить с текущего момента
  step                          один проход конвейера: разбор или черновик (для проверки)
  llm-test [filter|writer]      проверить, что модель отвечает
  config check                  проверить файл настроек и найти незаполненные значения
  config show                   показать настройки без секретов
  config init                   создать файл настроек с примером

По умолчанию файл настроек — newsdesk.config.json рядом с newsdesk.mjs.
База данных лежит рядом с файлом настроек в папке data.`;

interface Args {
  command: string;
  rest: string[];
  configPath: string;
}

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  // By default the config sits next to the script, wherever it is started from.
  let configPath = resolve(dirname(fileURLToPath(import.meta.url)), "newsdesk.config.json");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--config" || arg === "-c") {
      configPath = argv[index + 1] ?? configPath;
      index += 1;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else {
      rest.push(arg);
    }
  }
  return { command: rest[0] ?? "help", rest: rest.slice(1), configPath: resolve(configPath) };
}

function stamp(): string {
  return new Date().toLocaleString("ru-RU", { hour12: false });
}

/** Config kept in one JSON file. Rereads the file when it changes on disk, so manual edits apply without a restart. */
class FileConfigStore implements ConfigStore {
  private readonly path: string;
  private cached: Config | null = null;
  private cachedMtime = 0;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Config> {
    const mtime = statSync(this.path).mtimeMs;
    if (this.cached !== null && mtime === this.cachedMtime) return this.cached;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8").replace(/^﻿/u, ""));
    } catch (cause) {
      // A half-saved or broken file must not stop a running service: keep the last good config.
      if (this.cached !== null) return this.cached;
      throw new ConfigError([`файл ${this.path} не читается как JSON: ${errorMessage(cause)}`]);
    }
    try {
      this.cached = resolveConfig(parsed);
    } catch (cause) {
      if (this.cached !== null) return this.cached;
      throw cause;
    }
    this.cachedMtime = mtime;
    return this.cached;
  }

  async save(next: Config): Promise<void> {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.cached = next;
    this.cachedMtime = statSync(this.path).mtimeMs;
  }
}

/** HTTP client that honours network.proxy from the config. `close` releases its connections so the process can exit. */
function createFetch(configStore: ConfigStore): { fetch: typeof fetch; close: () => Promise<void> } {
  let activeProxy: string | null = null;
  let dispatcher: Dispatcher = new Agent();
  const httpFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const config = await configStore.load();
    const proxy = config.network.proxy.trim();
    if (proxy !== activeProxy) {
      const previous = dispatcher;
      activeProxy = proxy;
      dispatcher = proxy === "" ? new Agent() : proxy === "env" ? new EnvHttpProxyAgent() : new ProxyAgent(proxy);
      void previous.close().catch(() => undefined);
    }
    return undiciFetch(input as never, { ...(init as object), dispatcher } as never) as unknown as Response;
  }) as typeof fetch;
  return { fetch: httpFetch, close: () => dispatcher.close().catch(() => undefined) };
}

function createLlm(configStore: ConfigStore, httpFetch: typeof fetch): LlmRunner {
  return {
    async run(request: LlmRequest): Promise<string> {
      const config = await configStore.load();
      const backend = resolveBackend(config, "standalone");
      if (backend === "bb-remote") {
        if (config.llm.bbUrl.trim() === "" || config.llm.bbToken.trim() === "") {
          throw new Error("Для моделей через bb заполните llm.bbUrl и llm.bbToken в настройках");
        }
        return createRemoteLlm({ bbUrl: config.llm.bbUrl, token: config.llm.bbToken, fetch: httpFetch }).run(request);
      }
      return createOpenAiLlm({ apiBaseUrl: config.llm.apiBaseUrl, apiKey: config.llm.apiKey, fetch: httpFetch }).run(request);
    },
  };
}

function storyLine(story: StoryView): string {
  return `№${story.id}  [${story.status}]${story.score === null ? "" : `  оценка ${story.score}`}  ${story.title}`;
}

function parseId(raw: string | undefined): number {
  const id = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(id)) throw new EngineError("Нужен номер сюжета, например: publish 12");
  return id;
}

async function main(): Promise<number> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`Нужен Node.js 22.13 или новее (сейчас ${process.versions.node}). Скачать: https://nodejs.org/`);
    return 1;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (args.command === "config" && args.rest[0] === "init") {
    if (existsSync(args.configPath)) {
      console.error(`Файл ${args.configPath} уже есть, не перезаписываю.`);
      return 1;
    }
    writeFileSync(args.configPath, `${JSON.stringify(deepMerge(DEFAULT_CONFIG, EXAMPLE_OVERRIDES), null, 2)}\n`, { mode: 0o600 });
    console.log(`Создан ${args.configPath}. Заполните telegram.botToken, telegram.channel, sources и раздел llm, затем: config check`);
    return 0;
  }
  if (!existsSync(args.configPath)) {
    console.error(
      `Нет файла настроек ${args.configPath}.\nСкопируйте newsdesk.config.example.json в newsdesk.config.json рядом с newsdesk.mjs и заполните его\n(или создайте его командой: node newsdesk.mjs config init, или укажите другой файл: --config путь).`,
    );
    return 1;
  }
  const configStore = new FileConfigStore(args.configPath);
  let config: Config;
  try {
    config = await configStore.load();
  } catch (cause) {
    console.error(errorMessage(cause));
    return 1;
  }
  const warnings = configWarnings(config, "standalone", {
    isPlaceholder: (value) => PLACEHOLDER_PATTERN.test(value.trim()),
    channelTarget,
  });
  if (args.command === "config") {
    if (args.rest[0] === "show") {
      console.log(JSON.stringify(redactConfig(config), null, 2));
      return 0;
    }
    if (warnings.length === 0) {
      console.log(`Файл настроек в порядке: ${args.configPath}`);
      return 0;
    }
    console.log(`Файл ${args.configPath} читается, но его нужно дозаполнить:\n${warnings.map((warning) => `  - ${warning}`).join("\n")}`);
    return 1;
  }

  const dataDir = resolve(dirname(args.configPath), "data");
  mkdirSync(dataDir, { recursive: true });
  // Node.js still labels its built-in SQLite experimental and says so on every start; that is noise here.
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  // Loaded here, after the version check, so an old Node.js gets a clear message instead of an import error.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(resolve(dataDir, "newsdesk.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  const store = new Store(db);
  const http = createFetch(configStore);
  const httpFetch = http.fetch;
  const serviceMode = args.command === "run";
  const platform: Platform = {
    runtime: "standalone",
    fetch: httpFetch,
    log(level, message) {
      // One-off commands print their own result; the service prints its log.
      if (!serviceMode && level === "info") return;
      const line = `${stamp()}  ${level === "info" ? " " : level === "warn" ? "!" : "X"}  ${message}`;
      if (level === "error") console.error(line);
      else console.log(line);
    },
    changed() {},
  };
  const llm = createLlm(configStore, httpFetch);
  const engine = new Engine({ store, platform, configStore, llm });
  const backend = resolveBackend(config, "standalone");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    switch (args.command) {
      case "run": {
        console.log(`${stamp()}     Редакция новостей запущена. Канал: ${config.telegram.channel || "не задан"}, модели: ${backend}. Остановить: Ctrl+C`);
        for (const warning of warnings) console.log(`${stamp()}  !  ${warning}`);
        await engine.syncSources(controller.signal).catch(() => undefined);
        const loops = Promise.all([
          engine.runCollector(controller.signal),
          engine.runPipeline(controller.signal),
          engine.runBot(controller.signal),
          engine.runMaintenance(controller.signal),
        ]);
        // Give the bot a moment to check the token, so the list below says what is really wrong.
        await sleep(6000, controller.signal);
        if (!controller.signal.aborted) {
          const overview = await engine.overview(backend);
          for (const problem of overview.problems) console.log(`${stamp()}  !  ${problem}`);
        }
        await loops;
        console.log(`${stamp()}     Остановлено.`);
        // 130 tells start.sh that the user stopped the service on purpose.
        return controller.signal.aborted ? 130 : 0;
      }
      case "status": {
        await engine.syncSources(controller.signal).catch(() => undefined);
        const overview = await engine.overview(backend);
        const counts = overview.counts;
        console.log(
          [
            `Канал: ${overview.channel}   модели: ${overview.llm.backend}`,
            `Источники: ${overview.sources.enabled} из ${overview.sources.total}, не читается: ${overview.sources.failing}`,
            `Сбор: ${overview.collector.enabled ? "включён" : "выключен"}, последний: ${overview.collector.lastRunAt === null ? "ещё не было" : new Date(overview.collector.lastRunAt).toLocaleString("ru-RU", { hour12: false })}`,
            `Бот: ${overview.bot.username === null ? "" : `@${overview.bot.username}, `}${({ off: "не запущен", starting: "запускается", ok: "работает", bad_token: "Telegram не принимает токен", conflict: "его опрашивает другая программа", error: "нет связи с Telegram" } as const)[overview.bot.state]}`,
            `Владелец: ${overview.owner.paired ? "привязан" : `не привязан, отправьте боту /start ${overview.owner.pairingCode}`}`,
            `Ждут разбора: ${overview.newPosts}, черновика: ${counts.candidate ?? 0}, решения: ${counts.proposed ?? 0}`,
            `Опубликовано: ${counts.published ?? 0}, отклонено: ${counts.rejected ?? 0}, отсеяно: ${counts.filtered ?? 0}, своих постов в памяти: ${overview.ownPosts}`,
            ...warnings.map((warning) => `! ${warning}`),
            ...overview.problems.map((problem) => `! ${problem}`),
          ].join("\n"),
        );
        return 0;
      }
      case "sources": {
        await engine.syncSources(controller.signal);
        const sources = engine.listSources();
        console.log(
          sources.length === 0
            ? "Список пуст. Добавить: node newsdesk.mjs add @канал"
            : sources
                .map(
                  (source) =>
                    `@${source.handle}  ${source.enabled ? "вкл" : "пауза"}  постов ${source.posts}, опубл. ${source.published}, откл. ${source.rejected}${source.lastError === null ? "" : `  ОШИБКА: ${source.lastError}`}`,
                )
                .join("\n"),
        );
        return 0;
      }
      case "add": {
        if (args.rest.length === 0) throw new EngineError("Укажите канал: add @канал");
        let failed = false;
        for (const item of args.rest) {
          try {
            const source = await engine.addSource(item, controller.signal);
            console.log(`Добавлен @${source.handle}${source.title === null ? "" : ` (${source.title})`}`);
          } catch (cause) {
            failed = true;
            console.log(`${item}: ${errorMessage(cause)}`);
          }
        }
        return failed ? 1 : 0;
      }
      case "remove":
        await engine.removeSource(args.rest[0] ?? "");
        console.log("Убран");
        return 0;
      case "pause":
      case "resume":
        await engine.setSourceEnabled(args.rest[0] ?? "", args.command === "resume");
        console.log(args.command === "resume" ? "Включён" : "На паузе");
        return 0;
      case "collect": {
        const results = await engine.collectOnce(controller.signal);
        console.log(
          results.length === 0
            ? "Нет включённых источников"
            : results.map((result) => `@${result.handle}: ${result.error ?? `новых постов ${result.stored}`}`).join("\n"),
        );
        return 0;
      }
      case "queue": {
        const status = (args.rest[0] ?? "proposed") as StoryStatus;
        if (!STATUSES.includes(status)) throw new EngineError(`Нет статуса "${status}". Есть: ${STATUSES.join(", ")}`);
        const stories = engine.listStories({ statuses: [status], limit: 50 });
        console.log(stories.length === 0 ? "Пусто" : stories.map(storyLine).join("\n"));
        return 0;
      }
      case "show": {
        const view = engine.storyView(engine.requireStory(parseId(args.rest[0])));
        console.log(
          [
            storyLine(view),
            ...(view.reason === null ? [] : [`Почему: ${view.reason}`]),
            ...(view.draftNote === null ? [] : [`Заметка: ${view.draftNote}`]),
            ...(view.lastError === null ? [] : [`Ошибка: ${view.lastError}`]),
            ...(view.publishedUrl === null ? [] : [`Опубликовано: ${view.publishedUrl}`]),
            "",
            view.draftHtml === null
              ? "(черновика ещё нет)"
              : `--- черновик, вариант ${view.draftVersion}${view.hasMedia ? ", с медиа" : ""} ---\n${view.draftHtml}`,
            "",
            ...view.sources.map((source) => `--- источник @${source.handle} ${source.url}\n${source.text}`),
          ].join("\n"),
        );
        return 0;
      }
      case "publish": {
        const story = await engine.decide(parseId(args.rest[0]), "publish", { signal: controller.signal });
        console.log(`Опубликовано: ${story.published_url ?? "(без ссылки)"}`);
        return 0;
      }
      case "reject":
        await engine.decide(parseId(args.rest[0]), "reject", { reason: args.rest.slice(1).join(" ").slice(0, 200) || null });
        console.log("Отклонено");
        return 0;
      case "regenerate": {
        const id = parseId(args.rest[0]);
        // Here the rewrite runs in this very process, so wait for it instead of queueing.
        await engine.draft(id, controller.signal, { instruction: args.rest.slice(1).join(" ").slice(0, 1000) || null, rewrite: true });
        console.log(`Готов новый вариант №${id}. Посмотреть: show ${id}`);
        return 0;
      }
      case "restore":
        await engine.decide(parseId(args.rest[0]), "restore");
        console.log("Возвращён в работу");
        return 0;
      case "reset": {
        if (!args.rest.includes("--yes")) {
          throw new EngineError("Сброс удаляет все собранные посты, предложения и отсев. Подтвердите: reset --yes");
        }
        const result = await engine.resetFromNow(controller.signal);
        console.log(
          `Сброшено: сюжетов ${result.stories}, постов ${result.posts}, сообщений убрано из Telegram ${result.messages}. Каналов с новой точки отсчёта: ${result.sources}.`,
        );
        return 0;
      }
      case "step": {
        const worked = await engine.pipelineStep(controller.signal);
        const overview = await engine.overview(backend);
        console.log(
          `${worked ? "Сделан один проход" : "Работы нет"}. Ждут разбора: ${overview.newPosts}, черновика: ${overview.counts.candidate ?? 0}, решения: ${overview.counts.proposed ?? 0}${overview.pipeline.lastError === null ? "" : `\nОшибка: ${overview.pipeline.lastError}`}`,
        );
        return overview.pipeline.lastError === null ? 0 : 1;
      }
      case "llm-test": {
        const which = args.rest[0] === "writer" ? "writer" : "filter";
        const model = which === "filter" ? config.llm.filterModel : config.llm.writerModel;
        const startedAt = Date.now();
        try {
          const text = await llm.run({
            task: "проверка",
            model,
            reasoning: "low",
            prompt: `${NO_TOOLS_PREAMBLE}\n\nВерни JSON-объект {"ok": true, "sum": <сумма 17 и 25>} и больше ничего.`,
            signal: controller.signal,
            timeoutMs: 4 * 60_000,
          });
          console.log(`${model} (${backend}): отвечает за ${Date.now() - startedAt} мс\n${text.trim().slice(0, 300)}`);
          return 0;
        } catch (cause) {
          console.log(`${model} (${backend}): ОШИБКА за ${Date.now() - startedAt} мс\n${errorMessage(cause)}`);
          return 1;
        }
      }
      default:
        console.error(`Нет команды "${args.command}".\n\n${HELP}`);
        return 1;
    }
  } catch (cause) {
    if (controller.signal.aborted) return 130;
    console.error(cause instanceof EngineError || cause instanceof ConfigError ? cause.message : `Ошибка: ${errorMessage(cause)}`);
    return 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    controller.abort();
    db.close();
    await http.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    console.error(`Сбой: ${errorMessage(cause)}`);
    process.exitCode = 1;
  },
);
