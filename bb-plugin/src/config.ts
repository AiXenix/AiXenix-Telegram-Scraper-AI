// One config for both ways of running the service: the bb plugin and the
// standalone script. The same JSON document works in either; a file exported
// from one can be loaded into the other.
import { z } from "zod";

const sourceEntrySchema = z.union([
  z.string(),
  z.object({ handle: z.string(), enabled: z.boolean().optional() }).strict(),
]);

export const configSchema = z
  .object({
    telegram: z
      .object({
        /** Bot token from @BotFather. Secret. */
        botToken: z.string().max(200),
        /** Channel approved posts go to: @username, or a numeric id like -1001234567890 for a private one. The bot must be its admin. */
        channel: z.string().trim().max(64),
        /** Telegram user id of the owner. Filled in by pairing: /start <code> in the bot. */
        ownerChatId: z.number().int().nullable(),
        /** Bot API address. Change only for tests or a local Bot API server. */
        apiBase: z.string().trim().max(200),
      })
      .strict(),
    /** Channels to watch: "@name" or { handle, enabled }. The bot and the admin page edit this list. */
    sources: z.array(sourceEntrySchema).max(500),
    llm: z
      .object({
        /**
         * Where model requests go.
         * - "bb-threads": hidden bb threads on the subscriptions connected to bb (inside the plugin only).
         * - "bb-remote": the same, called over HTTP from the standalone script (needs bbUrl and bbToken).
         * - "openai": any OpenAI-compatible API (needs apiBaseUrl and apiKey).
         * - "auto": bb-threads inside the plugin; outside it bb-remote when bbUrl is set, otherwise openai.
         */
        backend: z.enum(["auto", "bb-threads", "bb-remote", "openai"]),
        filterModel: z.string().trim().min(1).max(80),
        writerModel: z.string().trim().min(1).max(80),
        filterReasoning: z.string().trim().min(1).max(20),
        writerReasoning: z.string().trim().min(1).max(20),
        /**
         * Address of the bb server for bb-remote, reachable directly, e.g. http://127.0.0.1:38886
         * on the same machine. The public *.getbb.app address asks for a login and will not work.
         */
        bbUrl: z.string().trim().max(300),
        /** Token of the newsdesk plugin (`bb plugin token newsdesk`). Secret. For bb-remote. */
        bbToken: z.string().max(300),
        /** For openai: base address ending in /v1. */
        apiBaseUrl: z.string().trim().max(300),
        /** For openai. Secret. */
        apiKey: z.string().max(300),
        /** bb project the hidden model threads run in; null picks the personal project. */
        workerProjectId: z.string().nullable(),
      })
      .strict(),
    editorial: z
      .object({
        /** What the channel is about; the filter judges relevance against this. */
        channelProfile: z.string().max(4000),
        /** How posts are written; drafts follow this. */
        styleGuide: z.string().max(12000),
        /** Appended to every draft as the last line. Empty for none. */
        footer: z.string().max(200),
        /**
         * true: every new story is proposed and only repeats of a known story are dropped;
         * the service does not judge what is interesting. false: it also drops what does not
         * fit channelProfile or scores below minScore.
         */
        proposeAll: z.boolean(),
        /** Drop posts explicitly marked as advertising (#реклама, erid). */
        skipAds: z.boolean(),
        /** With proposeAll off: stories scoring below this (0-100) go to the filtered list. */
        minScore: z.number().int().min(0).max(100),
        /** Posts without media and with less text than this are skipped: there is nothing to write from. */
        minTextLength: z.number().int().min(0).max(2000),
        /** Posts older than this when collected are skipped. */
        maxAgeHours: z.number().int().min(1).max(24 * 14),
        /** How far back published, rejected and pending stories block repeats. */
        memoryDays: z.number().int().min(1).max(180),
        /** A proposal nobody decided on within this many hours moves to the filtered list. */
        proposalTtlHours: z.number().int().min(1).max(24 * 30),
      })
      .strict(),
    schedule: z
      .object({
        pollMinutes: z.number().int().min(1).max(120),
        collectEnabled: z.boolean(),
        pipelineEnabled: z.boolean(),
      })
      .strict(),
    network: z
      .object({
        /**
         * Outgoing proxy for the standalone script: "" for none, "env" to use
         * HTTPS_PROXY / HTTP_PROXY, or an address like http://user:pass@host:port.
         * The bb plugin ignores it.
         */
        proxy: z.string().trim().max(300),
      })
      .strict(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

/** Paths of the secret fields, for redaction and for storing them apart from the rest. */
export const SECRET_PATHS = [
  ["telegram", "botToken"],
  ["llm", "bbToken"],
  ["llm", "apiKey"],
] as const;

export const DEFAULT_STYLE_GUIDE = [
  "Пиши по-русски, спокойно и по делу, как редактор новостного канала про ИИ.",
  "Первый абзац — суть новости одним-двумя предложениями: кто, что сделал, чем это важно.",
  "Дальше 1–3 коротких абзаца с фактами и цифрами из источника. Перечень из нескольких пунктов оформляй списком через «•» или «-».",
  "Ссылки на первоисточник, репозиторий или сервис ставь прямо в текст: на слово через <a href> или отдельной строкой.",
  "Без эмодзи, без хэштегов, без восклицаний и рекламных оборотов. Не упоминай канал-источник.",
  "Длина 300–900 знаков.",
].join("\n");

export const DEFAULT_CONFIG: Config = {
  telegram: {
    botToken: "",
    channel: "",
    ownerChatId: null,
    apiBase: "https://api.telegram.org",
  },
  sources: [],
  llm: {
    backend: "auto",
    filterModel: "gpt-6.1-terra",
    writerModel: "gpt-6.2-sol",
    filterReasoning: "low",
    writerReasoning: "medium",
    bbUrl: "",
    bbToken: "",
    apiBaseUrl: "",
    apiKey: "",
    workerProjectId: null,
  },
  editorial: {
    channelProfile:
      "Канал про искусственный интеллект: новые модели и их сравнение, инструменты и сервисы на ИИ, открытые проекты на GitHub, агенты для программирования, практические гайды, кейсы и промпты. Не подходят: политика, криптовалюты без связи с ИИ, реклама, розыгрыши, вакансии, анонсы чужих каналов.",
    styleGuide: DEFAULT_STYLE_GUIDE,
    footer: "",
    proposeAll: true,
    skipAds: true,
    minScore: 60,
    minTextLength: 15,
    maxAgeHours: 36,
    memoryDays: 21,
    proposalTtlHours: 48,
  },
  schedule: {
    pollMinutes: 3,
    collectEnabled: true,
    pipelineEnabled: true,
  },
  network: { proxy: "" },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively lays `patch` over `base`. Arrays and scalars replace; objects merge. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = key in base ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return result as T;
}

/** Settings older versions had and this one no longer uses; a file that still has them loads as before. */
const RETIRED: [section: string, key: string][] = [
  // Removed in 1.1: proposals are no longer rationed, everything that passes the filter is sent.
  ["editorial", "maxProposalsPerDay"],
];

function withoutRetired(stored: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...stored };
  for (const [section, key] of RETIRED) {
    const part = copy[section];
    if (isPlainObject(part) && key in part) {
      const { [key]: _dropped, ...rest } = part;
      copy[section] = rest;
    }
  }
  return copy;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * Stored config laid over the defaults, so a file written for an older
 * version (or one that lists only what differs) still loads. Throws with a
 * readable list when a value has the wrong type or range.
 */
export function resolveConfig(stored: unknown): Config {
  const merged = deepMerge(DEFAULT_CONFIG, withoutRetired(isPlainObject(stored) ? stored : {}));
  const parsed = configSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(корень)"}: ${issue.message}`);
  throw new ConfigError(issues);
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Ошибка в настройках:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface SourceEntry {
  handle: string;
  enabled: boolean;
}

/** The sources list in one shape, without duplicates. Entries that are not channel names are dropped. */
export function normalizeSources(config: Config, parseHandle: (input: string) => string | null): SourceEntry[] {
  const seen = new Map<string, SourceEntry>();
  for (const entry of config.sources) {
    const raw = typeof entry === "string" ? entry : entry.handle;
    const handle = parseHandle(raw);
    if (handle === null || seen.has(handle)) continue;
    seen.set(handle, { handle, enabled: typeof entry === "string" ? true : entry.enabled !== false });
  }
  return [...seen.values()];
}

/** Sources back in the compact file form: a plain "@name" unless the source is paused. */
export function serializeSources(entries: SourceEntry[]): Config["sources"] {
  return entries.map((entry) => (entry.enabled ? `@${entry.handle}` : { handle: `@${entry.handle}`, enabled: false }));
}

/** A copy safe to show or export: secrets replaced by a marker that says only whether they are set. */
export function redactConfig(config: Config): Config {
  const copy = structuredClone(config) as Config;
  for (const [section, key] of SECRET_PATHS) {
    const holder = copy[section] as Record<string, unknown>;
    holder[key] = typeof holder[key] === "string" && holder[key] !== "" ? REDACTED : "";
  }
  return copy;
}

export const REDACTED = "***";

/**
 * Applies an edited config over the current one. A secret left as the
 * redaction marker keeps its current value, so a round trip through the
 * admin page or an exported file does not wipe tokens.
 */
export function applyConfigEdit(current: Config, edited: unknown): Config {
  const next = resolveConfig(deepMerge(current, edited));
  for (const [section, key] of SECRET_PATHS) {
    const holder = next[section] as Record<string, unknown>;
    if (holder[key] === REDACTED) holder[key] = (current[section] as Record<string, unknown>)[key];
  }
  return next;
}

/**
 * Settings that are valid JSON but cannot work: placeholders left from the
 * example, missing values the chosen backend needs. Messages in Russian, like
 * the rest of the user-facing output.
 */
export function configWarnings(
  config: Config,
  runtime: "bb" | "standalone",
  helpers: { isPlaceholder: (value: string) => boolean; channelTarget: (value: string) => string | null },
): string[] {
  const warnings: string[] = [];
  const { telegram, llm, editorial } = config;
  const token = telegram.botToken.trim();
  if (token === "") warnings.push("telegram.botToken пуст: вставьте токен бота от @BotFather.");
  else if (helpers.isPlaceholder(token)) warnings.push("telegram.botToken — заглушка из примера: вставьте токен бота от @BotFather.");
  else if (!/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) warnings.push("telegram.botToken не похож на токен бота (вид: 123456789:AA...).");
  const channel = telegram.channel.trim();
  if (channel === "") warnings.push("telegram.channel пуст: укажите @имя вашего канала.");
  else if (helpers.isPlaceholder(channel)) warnings.push("telegram.channel — заглушка из примера: укажите @имя вашего канала.");
  else if (helpers.channelTarget(channel) === null) warnings.push(`telegram.channel «${channel}» указан неверно: нужно @имя канала.`);
  const sources = config.sources.map((entry) => (typeof entry === "string" ? entry : entry.handle));
  if (sources.length === 0) warnings.push("sources пуст: добавьте каналы, за которыми следить.");
  const placeholderSources = sources.filter((source) => helpers.isPlaceholder(source));
  if (placeholderSources.length > 0) warnings.push(`sources содержит заглушки из примера: ${placeholderSources.join(", ")}.`);
  const backend = resolveBackend(config, runtime);
  if (backend === "openai") {
    if (llm.apiBaseUrl.trim() === "") warnings.push("llm.apiBaseUrl пуст: укажите адрес API с /v1 на конце.");
    else if (!/\/v1\/?$/u.test(llm.apiBaseUrl.trim())) warnings.push("llm.apiBaseUrl обычно заканчивается на /v1.");
    if (llm.apiKey.trim() === "" || helpers.isPlaceholder(llm.apiKey.trim())) {
      warnings.push("llm.apiKey не задан: вставьте ключ API (для локального сервера без ключа подойдёт любое значение).");
    }
    for (const field of ["filterModel", "writerModel"] as const) {
      if (helpers.isPlaceholder(llm[field])) warnings.push(`llm.${field} — заглушка из примера: укажите название модели вашего поставщика.`);
    }
  }
  if (backend === "bb-remote" && (llm.bbUrl.trim() === "" || llm.bbToken.trim() === "")) {
    warnings.push("Для llm.backend bb-remote нужны llm.bbUrl и llm.bbToken.");
  }
  if (helpers.isPlaceholder(editorial.footer.trim())) warnings.push("editorial.footer — заглушка из примера: укажите свою подпись или \"\".");
  return warnings;
}

/** Which model backend to use in the given runtime. */
export function resolveBackend(config: Config, runtime: "bb" | "standalone"): "bb-threads" | "bb-remote" | "openai" {
  const { backend, bbUrl } = config.llm;
  if (backend !== "auto") {
    if (backend === "bb-threads" && runtime === "standalone") return "bb-remote";
    return backend;
  }
  if (runtime === "bb") return "bb-threads";
  return bbUrl !== "" ? "bb-remote" : "openai";
}
