// The editorial pipeline: triage (find repeats of a known story; optionally
// also judge relevance) and drafting (write the post in the channel's voice).
import { z } from "zod";
import type { Config } from "./config.ts";
import type { LlmRunner } from "./platform.ts";
import type { PostRow, Store, StoryRow, StoryStatus } from "./db.ts";
import { NO_TOOLS_PREAMBLE } from "./llm/shared.ts";
import {
  ReplyFormatError,
  contentTokens,
  escapeHtml,
  extractJson,
  firstSentence,
  linkKeys,
  overlap,
  sanitizeTelegramHtml,
  truncate,
  visibleLength,
} from "./text.ts";

export interface PipelineContext {
  store: Store;
  llm: LlmRunner;
  config: Config;
  signal: AbortSignal;
}

/** The reason recorded on stories the owner sent or forwarded to the bot. */
export const MANUAL_REASON = "прислано вручную";

/** Telegram's hard limits on visible characters. */
export const CAPTION_LIMIT = 1024;
export const MESSAGE_LIMIT = 4096;

/** Posts sent to the filter model in one request. */
export const TRIAGE_BATCH = 10;

export interface StoredMedia {
  /** animation (GIF) and document come only through Telegram itself (forwarded or taken by the account). */
  kind: "photo" | "video" | "animation" | "document" | "other";
  url: string | null;
  thumb?: string | null;
  /** Telegram file id: from a post the owner forwarded, or taken through the account. No size limit. */
  fileId?: string;
}

const SENDABLE_KINDS = new Set<StoredMedia["kind"]>(["photo", "video", "animation", "document"]);

/** An item the bot can send: a file id of any kind, or a downloadable photo or video. */
export function isSendable(item: StoredMedia): boolean {
  if (!SENDABLE_KINDS.has(item.kind)) return false;
  if (item.fileId !== undefined) return true;
  return (item.kind === "photo" || item.kind === "video") && item.url !== null;
}

export function parseMedia(json: string): StoredMedia[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as StoredMedia[]) : [];
  } catch {
    return [];
  }
}

/** Media that can actually be sent, at most one album. Items that cannot be sent are left out, the rest still go. */
export function usableMedia(post: PostRow): StoredMedia[] {
  return parseMedia(post.media_json).filter(isSendable).slice(0, 10);
}

/** How many of the post's media items cannot be sent (too big for the web preview, or a kind it does not give). */
export function missingMedia(post: PostRow): number {
  return parseMedia(post.media_json).filter((item) => !isSendable(item)).length;
}

/** The earliest source post whose media can be reused. */
export function pickMediaPost(posts: PostRow[]): PostRow | null {
  return posts.find((post) => usableMedia(post).length > 0) ?? null;
}

const AD_MARKERS = /(#реклама|#ad\b|erid[:=\s]|реклама\.\s|на правах рекламы|#промо)/iu;

/**
 * Checks that need no model and no taste: age, nothing to write from, a post
 * marked as advertising, our own post forwarded back. Returns the reason to
 * skip, or null to keep the post.
 */
export function prefilter(post: PostRow, config: Config, nowMs: number): string | null {
  if (nowMs - new Date(post.posted_at).getTime() > config.editorial.maxAgeHours * 3_600_000) return "устарел";
  const text = post.text.trim();
  if (text === "") return "нет текста";
  const hasMedia = parseMedia(post.media_json).some((item) => item.kind !== "other");
  // A short caption under a picture or a video is still a post; a few bare words are not.
  if (text.length < config.editorial.minTextLength && !hasMedia) return "слишком мало текста";
  if (config.editorial.skipAds && AD_MARKERS.test(text)) return "реклама";
  const ownHandle = config.telegram.channel.replace(/^@/u, "").toLowerCase();
  if (ownHandle !== "" && post.fwd_from !== null && post.fwd_from.toLowerCase().includes(ownHandle)) {
    return "репост с нашего канала";
  }
  return null;
}

export interface Candidate {
  story: StoryRow;
  similarity: number;
}

/** Stories that might be the same news, by shared links or shared words. */
export function findCandidates(
  tokens: string[],
  keys: string[],
  stories: StoryRow[],
  limit = 4,
  minSimilarity = 0.3,
): Candidate[] {
  const keySet = new Set(keys);
  const scored: Candidate[] = [];
  for (const story of stories) {
    const storyTokens = story.tokens === "" ? [] : story.tokens.split(" ");
    let similarity = overlap(tokens, storyTokens);
    // A short token set overlaps with anything; require a real number of shared words.
    if (Math.min(tokens.length, storyTokens.length) < 6) similarity *= 0.6;
    if (story.link_keys !== "" && story.link_keys.split(" ").some((key) => keySet.has(key))) {
      similarity = Math.max(similarity, 0.9);
    }
    if (similarity >= minSimilarity) scored.push({ story, similarity });
  }
  return scored.sort((left, right) => right.similarity - left.similarity).slice(0, limit);
}

export const STATUS_LABEL: Record<StoryStatus, string> = {
  own: "уже опубликовано на канале",
  published: "уже опубликовано на канале",
  publishing: "уже опубликовано на канале",
  rejected: "владелец отклонил",
  proposed: "уже предложено владельцу",
  candidate: "уже в очереди",
  failed: "уже в очереди",
  filtered: "отсеяно ранее",
};

// Models fill unused fields with null and sometimes quote numbers; accept both.
const verdictSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((value) => Number(value)).pipe(z.number().int()),
  verdict: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(["new", "duplicate", "skip"])),
  duplicate_of: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((value) => (value === null || value === undefined ? null : String(value))),
  score: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((value) => {
      const number = value === null || value === undefined ? Number.NaN : Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
    }),
  title: z.string().nullish().transform((value) => value ?? undefined),
  summary: z.string().nullish().transform((value) => value ?? undefined),
  reason: z.string().nullish().transform((value) => value ?? undefined),
});
export type Verdict = z.infer<typeof verdictSchema>;

/** How many known stories the filter sees by title, newest first, besides the look-alikes found for each post. */
const MEMORY_TITLES = 120;

export function buildFilterPrompt(
  config: Config,
  posts: { post: PostRow; candidates: Candidate[] }[],
  examples: { accepted: string[]; rejected: string[] },
  memory: StoryRow[] = [],
): string {
  const all = config.editorial.proposeAll;
  const lines: string[] = [NO_TOOLS_PREAMBLE, ""];
  if (all) {
    lines.push(
      "Ты помогаешь редактору Telegram-канала не публиковать один и тот же новостной повод дважды.",
      "Твоя задача — только найти повторы. Не оценивай, интересна ли новость и подходит ли она каналу: это решает редактор.",
    );
  } else {
    lines.push("Ты — редактор, который отбирает новости для Telegram-канала.", "", "О КАНАЛЕ:", config.editorial.channelProfile.trim());
    if (examples.accepted.length > 0 || examples.rejected.length > 0) {
      lines.push("", "НЕДАВНИЕ РЕШЕНИЯ ВЛАДЕЛЬЦА (учитывай его вкус):");
      for (const title of examples.accepted) lines.push(`+ принял: ${title}`);
      for (const title of examples.rejected) lines.push(`- отклонил: ${title}`);
    }
  }
  if (memory.length > 0) {
    lines.push("", "ПАМЯТЬ — новостные поводы, которые редактор уже видел:");
    for (const story of memory.slice(0, MEMORY_TITLES)) {
      lines.push(`[S${story.id}] (${STATUS_LABEL[story.status]}) ${truncate(story.title, 110)}`);
    }
  }
  lines.push("", all ? "ПОСТЫ:" : "ПОСТЫ НА ОЦЕНКУ:");
  for (const { post, candidates } of posts) {
    lines.push(
      "",
      `<post id="${post.id}" source="@${post.source_handle}" date="${post.posted_at.slice(0, 16)}">`,
      truncate(post.text, 1800),
      "</post>",
    );
    if (candidates.length > 0) {
      lines.push(`Похожие сюжеты из памяти для поста ${post.id}:`);
      for (const { story } of candidates) {
        lines.push(`- [S${story.id}] (${STATUS_LABEL[story.status]}) ${story.title} — ${truncate(story.summary, 220)}`);
      }
    }
  }
  lines.push(
    "",
    "Для каждого поста верни объект с полями:",
    '- "id": номер поста;',
    all ? '- "verdict": "duplicate" или "new";' : '- "verdict": "duplicate", "skip" или "new";',
    '- "duplicate_of": для duplicate — "S<номер>" сюжета из памяти или "P<id>" более раннего поста из этого списка, иначе null;',
    ...(all ? [] : ['- "score": для new — целое 0–100, насколько новость интересна и полезна аудитории канала;']),
    '- "title": заголовок новостного повода по-русски, до 90 знаков;',
    '- "summary": суть в одном-двух предложениях по-русски;',
    all
      ? '- "reason": для duplicate — одна короткая фраза, в чём совпадение; для new — пустая строка.'
      : '- "reason": одна короткая фраза, почему такой вердикт или оценка.',
    "",
    "Правила:",
    "- duplicate: пост о том же новостном поводе — том же событии, релизе, продукте, заявлении, — что сюжет из памяти или более ранний пост списка. Пересказ другими словами — повтор. Другие подробности о том же поводе (что умеет модель, цены, первые отзывы, чьё-то мнение о нём) — тоже повтор.",
    "- Новое событие с той же компанией или продуктом (следующий релиз, другое решение, другой день) — это не повтор, а новый повод.",
  );
  if (all) {
    lines.push(
      "- new: любой пост, который не повтор, на какую бы тему он ни был.",
      "- Подборка, в которой есть хотя бы один новый повод, — new; title и summary напиши о главном новом поводе.",
    );
  } else {
    lines.push(
      "- skip: реклама, розыгрыш, вакансия, анонс чужого канала или эфира, подборка ссылок без новости, мем или личное мнение без фактов, не по теме канала.",
      "- new: всё остальное. 80–100 — важная новость по теме, 60–79 — уместная, ниже 60 — слабая или на грани темы.",
      "- Если пост — подборка из нескольких несвязанных новостей, выбери из неё одну, самую важную для канала: оцени её и только о ней напиши title и summary.",
    );
  }
  lines.push("", "Ответь только JSON-массивом таких объектов, по одному на каждый пост, без пояснений и без обрамления.");
  return lines.join("\n");
}

export function parseFilterReply(reply: string): Verdict[] {
  const raw = extractJson(reply);
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? (Object.values(raw).find((value) => Array.isArray(value)) ?? [raw])
      : [];
  const verdicts: Verdict[] = [];
  for (const item of list as unknown[]) {
    const parsed = verdictSchema.safeParse(item);
    if (parsed.success) verdicts.push(parsed.data);
  }
  return verdicts;
}

/** Runs a model request again once when the reply came back in the wrong format. */
async function withFormatRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (!(cause instanceof ReplyFormatError)) throw cause;
    return run();
  }
}

export interface TriageOutcome {
  processed: number;
  candidates: number;
  duplicates: number;
  filtered: number;
  skipped: number;
  /** Posts the model gave no usable verdict for; they stay new and are retried. */
  unresolved: number[];
}

function storyFromPost(
  store: Store,
  post: PostRow,
  status: StoryStatus,
  fields: {
    title?: string;
    summary?: string;
    score?: number | null;
    reason?: string | null;
    manual?: boolean;
    duplicateOf?: number | null;
  },
): StoryRow {
  const links = JSON.parse(post.links_json) as string[];
  const title = (fields.title ?? "").trim() || firstSentence(post.text);
  const summary = (fields.summary ?? "").trim() || truncate(post.text.replace(/\s+/gu, " "), 240);
  return store.createStory({
    status,
    title: truncate(title, 140),
    summary: truncate(summary, 500),
    score: fields.score ?? null,
    reason: fields.reason ?? null,
    tokens: contentTokens(`${title} ${post.text}`),
    linkKeys: linkKeys(links),
    manual: fields.manual,
    duplicateOf: fields.duplicateOf ?? null,
  });
}

/** The story a chain of repeats leads back to. */
function rootOf(store: Store, story: StoryRow): StoryRow {
  let current = story;
  for (let depth = 0; depth < 10 && current.duplicate_of !== null; depth += 1) {
    const parent = store.getStory(current.duplicate_of);
    if (parent === undefined) break;
    current = parent;
  }
  return current;
}

/**
 * Records a post as a repeat of a known story: it gets its own entry in the
 * filtered list, saying what it repeats, and the original learns its words
 * and links so that later repeats are recognized more easily.
 */
function recordDuplicate(
  store: Store,
  post: PostRow,
  original: StoryRow,
  fields: { title?: string; summary?: string; why?: string } = {},
): StoryRow {
  const root = rootOf(store, original);
  const why = (fields.why ?? "").trim();
  const story = storyFromPost(store, post, "filtered", {
    title: fields.title,
    summary: fields.summary,
    reason: `повтор (${STATUS_LABEL[root.status]}): №${root.id} «${truncate(root.title, 90)}»${why === "" ? "" : ` — ${truncate(why, 160)}`}`,
    duplicateOf: root.id,
  });
  store.settlePost(post.id, { state: "done", storyId: story.id });
  mergeIntoStory(store, root, post);
  return story;
}

/** Adds a later post's words and links to its story, so further repeats match better. */
function mergeIntoStory(store: Store, story: StoryRow, post: PostRow): void {
  const tokens = new Set(story.tokens === "" ? [] : story.tokens.split(" "));
  for (const token of contentTokens(post.text)) tokens.add(token);
  const keys = new Set(story.link_keys === "" ? [] : story.link_keys.split(" "));
  for (const key of linkKeys(JSON.parse(post.links_json) as string[])) keys.add(key);
  store.updateStory(story.id, { tokens: [...tokens].slice(0, 400).join(" "), link_keys: [...keys].slice(0, 40).join(" ") });
}

/**
 * Takes the next batch of new posts through the cheap checks and the filter
 * model. One model request per call.
 */
export async function triageBatch(ctx: PipelineContext, onlyPostIds?: number[]): Promise<TriageOutcome> {
  const { store, config } = ctx;
  const outcome: TriageOutcome = { processed: 0, candidates: 0, duplicates: 0, filtered: 0, skipped: 0, unresolved: [] };
  const batch =
    onlyPostIds === undefined
      ? store.newPosts(TRIAGE_BATCH * 3)
      : onlyPostIds.map((id) => store.getPost(id)).filter((post): post is PostRow => post?.state === "new");
  if (batch.length === 0) return outcome;

  const forModel: PostRow[] = [];
  const now = Date.now();
  for (const post of batch) {
    const skipReason = prefilter(post, config, now);
    if (skipReason !== null) {
      store.settlePost(post.id, { state: "skipped", skipReason });
      outcome.skipped += 1;
      outcome.processed += 1;
      continue;
    }
    const twin = store.findPostByFingerprint(post.fingerprint, post.id);
    const twinStory = twin?.story_id == null ? undefined : store.getStory(twin.story_id);
    if (twinStory !== undefined) {
      recordDuplicate(store, post, twinStory, { why: "тот же текст" });
      outcome.duplicates += 1;
      outcome.processed += 1;
      continue;
    }
    if (forModel.length < TRIAGE_BATCH) forModel.push(post);
  }
  if (forModel.length === 0) return outcome;

  // Repeats point at their original, so only originals are worth comparing with.
  const memory = store
    .recentStories(new Date(now - config.editorial.memoryDays * 86_400_000).toISOString())
    .filter((story) => story.duplicate_of === null);
  const withCandidates = forModel.map((post) => ({
    post,
    candidates: findCandidates(contentTokens(post.text), linkKeys(JSON.parse(post.links_json) as string[]), memory, 5, 0.25),
  }));
  const decided = config.editorial.proposeAll
    ? []
    : store.listStories({ statuses: ["published", "rejected"], limit: 30, offset: 0 });
  const examples = {
    accepted: decided.filter((story) => story.status === "published").slice(0, 10).map((story) => story.title),
    rejected: decided
      .filter((story) => story.status === "rejected")
      .slice(0, 10)
      .map((story) => (story.decision_reason ? `${story.title} (${story.decision_reason})` : story.title)),
  };

  const prompt = buildFilterPrompt(config, withCandidates, examples, memory);
  const verdictList = await withFormatRetry(async () =>
    parseFilterReply(
      await ctx.llm.run({
        task: "отбор",
        model: config.llm.filterModel,
        reasoning: config.llm.filterReasoning,
        prompt,
        signal: ctx.signal,
      }),
    ),
  );
  const verdicts = new Map(verdictList.map((verdict) => [verdict.id, verdict]));
  const knownStoryIds = new Set(memory.map((story) => story.id));
  const storyOfPost = new Map<number, number>();
  const all = config.editorial.proposeAll;

  for (const post of forModel) {
    const verdict = verdicts.get(post.id);
    if (verdict === undefined) {
      outcome.unresolved.push(post.id);
      continue;
    }
    outcome.processed += 1;
    if (verdict.verdict === "duplicate") {
      const ref = (verdict.duplicate_of ?? "").trim().toUpperCase();
      const number = Number.parseInt(ref.slice(1), 10);
      const targetStoryId =
        ref.startsWith("S") && knownStoryIds.has(number)
          ? number
          : ref.startsWith("P")
            ? (storyOfPost.get(number) ?? null)
            : null;
      const target = targetStoryId === null ? undefined : store.getStory(targetStoryId);
      if (target !== undefined) {
        const story = recordDuplicate(store, post, target, { title: verdict.title, summary: verdict.summary, why: verdict.reason });
        storyOfPost.set(post.id, story.duplicate_of ?? story.id);
        outcome.duplicates += 1;
        continue;
      }
      if (!all) {
        // A repeat of something we cannot identify: keep it out of the queue, visible in the filtered list.
        const story = storyFromPost(store, post, "filtered", {
          title: verdict.title,
          summary: verdict.summary,
          reason: `повтор: ${verdict.reason ?? "модель не указала, чего именно"}`,
        });
        store.settlePost(post.id, { state: "done", storyId: story.id });
        storyOfPost.set(post.id, story.id);
        outcome.filtered += 1;
        continue;
      }
      // Propose-everything mode: a repeat we cannot pin to a known story is treated as new.
    }
    if (verdict.verdict === "skip" && !all) {
      const story = storyFromPost(store, post, "filtered", {
        title: verdict.title,
        summary: verdict.summary,
        // A score says how good a fitting story is; a story that does not fit has none.
        score: null,
        reason: verdict.reason ?? "не подходит каналу",
      });
      store.settlePost(post.id, { state: "done", storyId: story.id });
      storyOfPost.set(post.id, story.id);
      outcome.filtered += 1;
      continue;
    }
    const score = all ? null : (verdict.score ?? 0);
    const passes = all || (score ?? 0) >= config.editorial.minScore;
    const story = storyFromPost(store, post, passes ? "candidate" : "filtered", {
      title: verdict.title,
      summary: verdict.summary,
      score,
      reason: all ? null : (verdict.reason ?? null),
    });
    store.settlePost(post.id, { state: "done", storyId: story.id });
    storyOfPost.set(post.id, story.id);
    if (passes) outcome.candidates += 1;
    else outcome.filtered += 1;
  }
  return outcome;
}

const draftSchema = z.object({ text: z.string().min(1), comment: z.string().nullish() });

export function buildDraftPrompt(input: {
  config: Config;
  /** What the post is about, as the filter named it. Keeps the writer on one story when a source carries several. */
  topic?: { title: string; summary: string } | null;
  sources: PostRow[];
  examples: string[];
  limit: number;
  previous?: string | null;
  instruction?: string | null;
}): string {
  const { config, sources, examples, limit } = input;
  const lines: string[] = [
    NO_TOOLS_PREAMBLE,
    "",
    "Ты — автор Telegram-канала. Напиши один пост по материалам ниже.",
    "",
    "О КАНАЛЕ:",
    config.editorial.channelProfile.trim(),
    "",
    "СТИЛЬ:",
    config.editorial.styleGuide.trim(),
  ];
  if (examples.length > 0) {
    lines.push("", "ПРИМЕРЫ ПОСТОВ КАНАЛА (ориентир по тону, длине и оформлению; содержание из них не бери):");
    examples.forEach((example, index) => {
      lines.push(`<example n="${index + 1}">`, truncate(example, 1000), "</example>");
    });
  }
  if (input.topic) {
    lines.push(
      "",
      "ТЕМА ПОСТА:",
      `${input.topic.title}${input.topic.summary === "" ? "" : ` — ${input.topic.summary}`}`,
      "Пиши только об этом. Если в материалах есть другие новости, не включай их.",
    );
  }
  lines.push("", "МАТЕРИАЛЫ:");
  sources.forEach((post, index) => {
    lines.push(
      `<source n="${index + 1}" channel="@${post.source_handle}" date="${post.posted_at.slice(0, 16)}">`,
      truncate(post.text, 6000),
      "</source>",
    );
  });
  if (input.previous) {
    lines.push("", "ПРЕДЫДУЩИЙ ВАРИАНТ ПОСТА:", input.previous);
  }
  if (input.instruction) {
    lines.push("", "УКАЗАНИЕ РЕДАКТОРА (выполни его, остальное сохрани):", input.instruction);
  } else if (input.previous) {
    lines.push("", "Редактор попросил другой вариант: напиши заметно иначе — другое начало и другая подача тех же фактов.");
  }
  lines.push(
    "",
    "Требования:",
    "- Только факты из материалов. Не добавляй от себя цифры, даты, названия, оценки и ссылки.",
    "- Перескажи своими словами, не копируй фразы источника.",
    "- Ссылки бери только из материалов и только на первоисточники, сервисы и репозитории. Ссылки на Telegram-каналы и упоминания каналов-источников не включай.",
    "- Разметка: Telegram HTML. Разрешены только теги <b>, <i>, <code> и <a href=\"адрес\">. Абзацы разделяй пустой строкой.",
    `- Длина не больше ${limit} знаков.`,
    "- Подпись канала в конце не добавляй, её добавит система.",
    "",
    'Ответь только JSON-объектом: {"text": "текст поста", "comment": "если в материалах чего-то не хватает или факт вызывает сомнение — одна фраза; иначе пустая строка"}',
  );
  return lines.join("\n");
}

export function parseDraftReply(reply: string): { text: string; comment: string } {
  const parsed = draftSchema.safeParse(extractJson(reply));
  if (!parsed.success) throw new ReplyFormatError("Модель вернула черновик в неверном формате");
  return { text: parsed.data.text, comment: (parsed.data.comment ?? "").trim() };
}

/** Sanitized draft with the channel signature as the last line. */
export function finalizeDraft(text: string, footer: string): string {
  let body = sanitizeTelegramHtml(text);
  const sign = footer.trim();
  if (sign === "") return body;
  // The model sometimes adds the signature despite the instruction; keep exactly one.
  const escaped = sign.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  body = body.replace(new RegExp(`\\s*${escaped}\\s*$`, "iu"), "").trimEnd();
  return `${body}\n\n${escapeHtml(sign)}`;
}

export interface DraftResult {
  html: string;
  mediaPostId: number | null;
  note: string | null;
}

/** Writes (or rewrites) the draft for a story. One or two model requests. */
export async function writeDraft(
  ctx: PipelineContext,
  story: StoryRow,
  options: { instruction?: string | null; rewrite?: boolean } = {},
): Promise<DraftResult> {
  const { store, config } = ctx;
  const sources = store.postsOfStory(story.id).slice(0, 4);
  if (sources.length === 0) throw new Error("У сюжета нет исходных постов");
  const mediaPost = pickMediaPost(sources);
  const footerLength = config.editorial.footer.trim() === "" ? 0 : config.editorial.footer.trim().length + 2;
  const hardLimit = (mediaPost === null ? MESSAGE_LIMIT : CAPTION_LIMIT) - footerLength;
  // Ask for a little less than a caption holds: the model's own count is approximate.
  const limit = mediaPost === null ? 1800 : hardLimit - 40;
  const examples = store.recentOwnTexts(6, 200);
  // A hand-sent post has no title from the filter; its own first line is not a reliable topic.
  const topic = story.reason === MANUAL_REASON ? null : { title: story.title, summary: story.summary };
  const previous = options.rewrite === true || options.instruction ? story.draft_html : null;

  const ask = (instruction: string | null, previousDraft: string | null) => {
    const prompt = buildDraftPrompt({ config, topic, sources, examples, limit, previous: previousDraft, instruction });
    return withFormatRetry(async () =>
      parseDraftReply(
        await ctx.llm.run({
          task: "черновик",
          model: config.llm.writerModel,
          reasoning: config.llm.writerReasoning,
          prompt,
          signal: ctx.signal,
        }),
      ),
    );
  };

  let draft = await ask(options.instruction ?? null, previous);
  let html = finalizeDraft(draft.text, config.editorial.footer);
  if (visibleLength(html) > hardLimit + footerLength) {
    draft = await ask(
      `Текст получился длиннее ${limit} знаков. Сократи его до ${limit} знаков, сохранив главное и ссылки.`,
      draft.text,
    );
    html = finalizeDraft(draft.text, config.editorial.footer);
  }
  const notes: string[] = [];
  if (draft.comment !== "") notes.push(draft.comment);
  let mediaPostId = mediaPost?.id ?? null;
  const length = visibleLength(html);
  if (length > MESSAGE_LIMIT) throw new Error(`Черновик длиннее ${MESSAGE_LIMIT} знаков даже после сокращения`);
  if (mediaPost !== null && length > CAPTION_LIMIT) {
    mediaPostId = null;
    notes.push(`Текст длиннее подписи к медиа (${length} из ${CAPTION_LIMIT} знаков), поэтому пост без медиа.`);
  }
  if (mediaPost === null && sources.some((post) => parseMedia(post.media_json).length > 0)) {
    notes.push("В источнике есть медиа, но взять файл не удалось (веб-версия Telegram не отдаёт большие видео и файлы; подключите аккаунт Telegram в настройках).");
  } else if (mediaPost !== null && missingMedia(mediaPost) > 0) {
    notes.push(`Приложено медиа: ${usableMedia(mediaPost).length} из ${usableMedia(mediaPost).length + missingMedia(mediaPost)}; остальное веб-версия Telegram не отдаёт.`);
  }
  return { html, mediaPostId, note: notes.length === 0 ? null : notes.join(" ") };
}
