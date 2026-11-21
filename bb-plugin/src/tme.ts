// Reads public Telegram channels through the web preview at t.me/s/<channel>.
// No account is needed; private channels and channels with the preview turned
// off are not reachable this way.
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export interface TmeMedia {
  kind: "photo" | "video" | "other";
  /** Direct file URL. Missing for videos Telegram does not serve on the web. */
  url: string | null;
  thumb: string | null;
}

export interface TmePost {
  channel: string;
  id: number;
  url: string;
  date: string;
  text: string;
  media: TmeMedia[];
  links: string[];
  forwardedFrom: string | null;
  views: number | null;
}

export interface TmeChannelPage {
  channel: string;
  title: string | null;
  description: string | null;
  posts: TmePost[];
}

export class TmeError extends Error {
  readonly code: "not_found" | "http" | "network";
  constructor(code: TmeError["code"], message: string) {
    super(message);
    this.name = "TmeError";
    this.code = code;
  }
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Where to post: "@name" for a public channel (from @name, name or a t.me link),
 * or a numeric chat id such as -1001234567890. Null when the value is neither.
 */
export function channelTarget(input: string): string | null {
  const trimmed = input.trim();
  if (/^-100\d{5,}$/u.test(trimmed)) return trimmed;
  const handle = parseChannelHandle(trimmed);
  return handle === null ? null : `@${handle}`;
}

/** Accepts @name, name, t.me/name, https://t.me/s/name and returns the bare lowercase username. */
export function parseChannelHandle(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = /^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})(?:[/?#].*)?$/u.exec(trimmed);
  const bare = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/u.exec(trimmed);
  const name = fromUrl?.[1] ?? bare?.[1];
  if (name === undefined) return null;
  const lower = name.toLowerCase();
  if (lower === "joinchat" || lower === "addstickers" || lower === "share") return null;
  return lower;
}

function backgroundUrl(style: string | undefined): string | null {
  if (style === undefined) return null;
  return /background-image:\s*url\(['"]?([^'")]+)['"]?\)/u.exec(style)?.[1] ?? null;
}

function parseCount(raw: string): number | null {
  const match = /^([\d.,]+)\s*([KkMm]?)$/u.exec(raw.trim());
  if (match === null) return null;
  const value = Number.parseFloat((match[1] ?? "").replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  return Math.round(value * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1));
}

function isElement(node: AnyNode): node is Element {
  return node.type === "tag";
}

/** Message HTML to plain text. Links whose label is not the address itself become "label (address)". */
function renderText($: cheerio.CheerioAPI, root: Element, links: Set<string>): string {
  const walk = (node: AnyNode): string => {
    if (node.type === "text") return node.data;
    if (!isElement(node)) return "";
    const name = node.name.toLowerCase();
    if (name === "br") return "\n";
    const inner = node.children.map(walk).join("");
    if (name === "a") {
      const href = node.attribs.href ?? "";
      if (!/^https?:\/\//iu.test(href)) return inner;
      // Hashtag and in-channel search links carry no information of their own.
      if (/^https?:\/\/t\.me\/s\/[^?]+\?q=/iu.test(href)) return inner;
      links.add(href);
      const label = inner.trim();
      const bareHref = href.replace(/^https?:\/\//iu, "").replace(/\/$/u, "");
      const bareLabel = label.replace(/^https?:\/\//iu, "").replace(/\/$/u, "");
      if (label === "" || bareLabel === bareHref || bareHref.startsWith(bareLabel.replace(/…$/u, ""))) return href;
      return `${label} (${href})`;
    }
    if (name === "blockquote" || name === "pre") return `\n${inner}\n`;
    return inner;
  };
  return root.children
    .map(walk)
    .join("")
    .replace(/ /gu, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function parseChannelPage(html: string, channel: string): TmeChannelPage {
  const $ = cheerio.load(html);
  if ($(".tgme_channel_info").length === 0 && $(".tgme_widget_message").length === 0) {
    throw new TmeError(
      "not_found",
      `Канал @${channel} не найден или у него выключен веб-просмотр (закрытый канал так не прочитать)`,
    );
  }
  const posts: TmePost[] = [];
  $(".tgme_widget_message").each((_, element) => {
    const message = $(element);
    if (message.hasClass("service_message")) return;
    const postRef = message.attr("data-post") ?? "";
    const idMatch = /\/(\d+)$/u.exec(postRef);
    if (idMatch === null) return;
    const id = Number.parseInt(idMatch[1] ?? "", 10);
    const date = message.find(".tgme_widget_message_date time").attr("datetime") ?? null;
    if (date === null || !Number.isFinite(id)) return;

    const links = new Set<string>();
    const textNode = message.find(".tgme_widget_message_text.js-message_text").last().get(0);
    const text = textNode === undefined ? "" : renderText($, textNode, links);

    const media: TmeMedia[] = [];
    message.find(".tgme_widget_message_photo_wrap").each((__, photo) => {
      media.push({ kind: "photo", url: backgroundUrl($(photo).attr("style")), thumb: null });
    });
    message.find(".tgme_widget_message_video_player").each((__, player) => {
      const video = $(player);
      media.push({
        kind: "video",
        url: video.find("video").attr("src") ?? null,
        thumb: backgroundUrl(video.find(".tgme_widget_message_video_thumb").attr("style")),
      });
    });
    if (
      message.find(
        ".tgme_widget_message_document, .tgme_widget_message_poll, .tgme_widget_message_voice, .tgme_widget_message_sticker_wrap, .tgme_widget_message_roundvideo_player",
      ).length > 0
    ) {
      media.push({ kind: "other", url: null, thumb: null });
    }

    const forwarded = message.find(".tgme_widget_message_forwarded_from_name").first();
    const viewsRaw = message.find(".tgme_widget_message_views").first().text();
    posts.push({
      channel,
      id,
      url: `https://t.me/${channel}/${id}`,
      date,
      text,
      media,
      links: [...links],
      forwardedFrom: forwarded.length === 0 ? null : forwarded.text().trim() || null,
      views: viewsRaw === "" ? null : parseCount(viewsRaw),
    });
  });
  posts.sort((left, right) => left.id - right.id);
  const title = $(".tgme_channel_info_header_title").first().text().trim() || null;
  const descriptionNode = $(".tgme_channel_info_description").first().get(0);
  const description = descriptionNode === undefined ? null : renderText($, descriptionNode, new Set()) || null;
  return { channel, title, description, posts };
}

export interface FetchPageOptions {
  /** Return the page of posts with ids below this one. */
  before?: number;
  /** Return the page of posts with ids above this one, oldest first. */
  after?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** HTTP client to use; defaults to the global one. */
  fetch?: typeof fetch;
}

export async function fetchChannelPage(channel: string, options: FetchPageOptions = {}): Promise<TmeChannelPage> {
  const url = new URL(`https://t.me/s/${channel}`);
  if (options.before !== undefined) url.searchParams.set("before", String(options.before));
  if (options.after !== undefined) url.searchParams.set("after", String(options.after));
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      signal,
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, "accept-language": "ru,en;q=0.8" },
    });
  } catch (cause) {
    if (options.signal?.aborted === true) throw cause;
    throw new TmeError("network", `t.me не ответил: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  // t.me redirects /s/<name> to /<name> when there is no public preview.
  if (response.status >= 300 && response.status < 400) {
    throw new TmeError(
      "not_found",
      `Канал @${channel} не найден или у него выключен веб-просмотр (закрытый канал так не прочитать)`,
    );
  }
  if (!response.ok) throw new TmeError("http", `t.me ответил кодом ${response.status}`);
  return parseChannelPage(await response.text(), channel);
}
