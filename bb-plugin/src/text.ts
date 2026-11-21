// Text helpers: normalization and lexical similarity for duplicate detection,
// plus a strict sanitizer for the HTML subset Telegram accepts.
import { createHash } from "node:crypto";

const STOPWORDS = new Set(
  (
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это также который которая которые которого которых свой свои своя своих наш наша наши ваш ваша очень просто теперь пока еще уже " +
    "the a an and or of to in on for with is are was were be been by at as it its this that these those from has have had will would can could should not no but if then than so such into over out up down new now just about via per you your we our they their he she his her i me my"
  )
    .split(/\s+/u)
    .filter(Boolean),
);

/** Lowercase, unify ё, drop URLs and everything except letters, digits and spaces. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/@[a-z0-9_]{3,}/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Stable hash of the normalized text: equal for reposts that only differ in links, emoji or punctuation. */
export function fingerprint(text: string): string {
  return createHash("sha1").update(normalizeText(text)).digest("hex").slice(0, 20);
}

/**
 * Content tokens for matching: stopwords removed, words cut to a 6-letter
 * prefix (a crude stemmer that folds Russian and English inflections).
 */
export function contentTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const word of normalizeText(text).split(" ")) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    seen.add(/^\d+$/u.test(word) ? word : word.slice(0, 6));
  }
  return [...seen];
}

/** Hosts and paths of external links, used as a strong "same story" signal. */
export function linkKeys(links: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const link of links) {
    try {
      const url = new URL(link);
      const host = url.hostname.replace(/^www\./u, "").toLowerCase();
      if (host === "t.me" || host === "telegram.me") continue;
      const path = url.pathname.replace(/\/+$/u, "").toLowerCase();
      if (path === "" || path === "/") continue;
      keys.add(`${host}${path}`);
    } catch {
      // not a URL, ignore
    }
  }
  return [...keys];
}

/** Share of the smaller token set that also appears in the other one (0..1). */
export function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const small = a.length <= b.length ? a : b;
  const large = new Set(a.length <= b.length ? b : a);
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.length;
}

/** Jaccard similarity of two token sets (0..1). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const token of a) if (setB.has(token)) shared += 1;
  return shared / (a.length + b.length - shared);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&");
}

const SIMPLE_TAGS = new Set(["b", "i", "u", "s", "code", "pre", "blockquote", "tg-spoiler"]);
const TAG_ALIASES: Record<string, string> = {
  strong: "b",
  em: "i",
  ins: "u",
  strike: "s",
  del: "s",
};

function safeHref(raw: string): string | null {
  const href = unescapeHtml(raw.trim());
  if (!/^(https?:\/\/|tg:\/\/)/iu.test(href)) return null;
  if (/[\s"<>]/u.test(href)) return null;
  return href.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

/**
 * Keep only the tags Telegram's HTML parse mode accepts, drop every attribute
 * except a safe `href`, escape stray angle brackets, and close what is left
 * open. Model output goes through this before it reaches the Bot API.
 */
export function sanitizeTelegramHtml(input: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gu;
  let last = 0;
  const pushText = (chunk: string) => {
    if (chunk === "") return;
    // Escape bare ampersands and angle brackets, keep existing entities.
    out.push(
      chunk
        .replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/giu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;"),
    );
  };
  for (const match of input.matchAll(pattern)) {
    const [whole, closing, rawName, attrs] = match;
    const index = match.index ?? 0;
    pushText(input.slice(last, index));
    last = index + whole.length;
    const lower = (rawName ?? "").toLowerCase();
    const name = TAG_ALIASES[lower] ?? lower;
    if (name === "br") {
      out.push("\n");
      continue;
    }
    if (name === "p" || name === "div") {
      if (closing === "/") out.push("\n");
      continue;
    }
    if (name !== "a" && !SIMPLE_TAGS.has(name)) continue; // unknown tag: drop it, keep its text
    if (closing === "/") {
      const at = stack.lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    if (name === "a") {
      const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attrs ?? "");
      const href = safeHref(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "");
      if (href === null || stack.includes("a")) continue;
      out.push(`<a href="${href}">`);
      stack.push("a");
      continue;
    }
    if (stack.includes(name)) continue; // Telegram rejects nesting a tag in itself
    out.push(`<${name}>`);
    stack.push(name);
  }
  pushText(input.slice(last));
  while (stack.length > 0) out.push(`</${stack.pop()}>`);
  return out
    .join("")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Text as the reader sees it: tags removed, entities decoded. */
export function htmlToPlain(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/gu, ""));
}

/** Length Telegram counts against its limits: UTF-16 units of the visible text. */
export function visibleLength(html: string): number {
  return htmlToPlain(html).length;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** First sentence or line, for a fallback title. */
export function firstSentence(text: string, max = 110): string {
  const line = text.trim().split(/\n/u)[0] ?? "";
  const sentence = /^.{20,}?[.!?](?=\s|$)/u.exec(line)?.[0] ?? line;
  return truncate(sentence.trim(), max);
}

/** The model answered, but not in the format the request asked for. Worth one more try. */
export class ReplyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyFormatError";
  }
}

/**
 * Repairs the one malformation seen in practice: a string value that lost its
 * opening quote (`"summary": Текст.",`). Works line by line, which is safe
 * because models print one field per line.
 */
function repairJson(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(\s*"[^"]+"\s*:\s*)(.*?)(,?\s*)$/u.exec(line);
      if (match === null) return line;
      const [, head, value, tail] = match as unknown as [string, string, string, string];
      if (value === "" || /^["[{\d-]/u.test(value) || /^(?:null|true|false)$/u.test(value)) return line;
      if (!value.endsWith('"')) return line;
      return `${head}"${value}${tail}`;
    })
    .join("\n");
}

function parseLoosely(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to bracket scan
  }
  // Try the bracket kind that opens first, so "[{...}]" is read as the array.
  const pairs = (
    [
      ["{", "}"],
      ["[", "]"],
    ] as const
  )
    .map(([open, close]) => ({ open, close, at: trimmed.indexOf(open) }))
    .filter((pair) => pair.at !== -1)
    .sort((left, right) => left.at - right.at);
  for (const { close, at: start } of pairs) {
    const end = trimmed.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // try the other bracket kind
    }
  }
  return undefined;
}

/**
 * Pull the first JSON object or array out of a model reply that may wrap it
 * in prose or a code fence. Throws ReplyFormatError when nothing parses.
 */
export function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(reply);
  const candidates = [fenced?.[1], reply].filter((value): value is string => typeof value === "string");
  for (const candidate of [...candidates, ...candidates.map(repairJson)]) {
    const parsed = parseLoosely(candidate);
    if (parsed !== undefined) return parsed;
  }
  throw new ReplyFormatError("Модель ответила не в формате JSON");
}
