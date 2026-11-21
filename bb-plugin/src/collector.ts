// Polls every enabled source and stores posts that appeared since the last
// visit. Each source keeps a cursor (the last message id seen), so nothing is
// lost across restarts: the next poll continues from the cursor. A cursor of
// NOT_STARTED means the channel has never been read: the first successful read
// only marks where "now" is, so older posts are not proposed.
import type { Config } from "./config.ts";
import type { SourceRow, Store } from "./db.ts";
import { fingerprint } from "./text.ts";
import { TmeError, fetchChannelPage, type TmeChannelPage, type TmePost } from "./tme.ts";

/** Cursor value for a source that has not been read successfully yet. */
export const NOT_STARTED = -1;

export type PageFetcher = (
  channel: string,
  options: { after?: number; before?: number; signal?: AbortSignal },
) => Promise<TmeChannelPage>;

/** A page fetcher bound to the platform's HTTP client. */
export function pageFetcher(httpFetch: typeof fetch): PageFetcher {
  return (channel, options) => fetchChannelPage(channel, { ...options, fetch: httpFetch });
}

export interface CollectResult {
  handle: string;
  stored: number;
  error: string | null;
}

/** How many pages one poll may walk for one source. A page holds about 20 posts. */
const MAX_PAGES_PER_POLL = 5;

function storePosts(store: Store, source: SourceRow, posts: TmePost[]): number {
  let stored = 0;
  for (const post of posts) {
    const inserted = store.insertPost({
      source_id: source.id,
      source_handle: source.handle,
      msg_id: post.id,
      url: post.url,
      posted_at: new Date(post.date).toISOString(),
      text: post.text,
      media_json: JSON.stringify(post.media),
      links_json: JSON.stringify(post.links),
      fwd_from: post.forwardedFrom,
      fingerprint: fingerprint(post.text),
    });
    if (inserted) stored += 1;
  }
  return stored;
}

/** Collects one source. Never throws for a source-level failure; it is recorded on the source. */
export async function collectSource(
  store: Store,
  source: SourceRow,
  config: Config,
  signal: AbortSignal,
  fetchPage: PageFetcher = fetchChannelPage,
): Promise<CollectResult> {
  try {
    let cursor = source.cursor;
    let stored = 0;
    let title: string | null = null;
    let lastPostAt: string | null = null;
    const staleBefore = Date.now() - config.editorial.maxAgeHours * 3_600_000;
    const accept = (posts: TmePost[]) => {
      const newest = posts[posts.length - 1];
      if (newest === undefined) return;
      stored += storePosts(store, source, posts);
      if (newest.id > cursor) {
        cursor = newest.id;
        lastPostAt = new Date(newest.date).toISOString();
      }
    };
    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_POLL; pageIndex += 1) {
      const initial = cursor === NOT_STARTED;
      const page = await fetchPage(source.handle, initial ? { signal } : { after: cursor, signal });
      title = page.title ?? title;
      const fresh = page.posts.filter((post) => post.id > cursor);
      const newest = fresh[fresh.length - 1];
      if (newest === undefined) {
        // An empty channel: from now on everything it posts is new.
        if (initial) cursor = 0;
        break;
      }
      if (initial) {
        // No starting point yet: watch from this moment on, without proposing what is already there.
        cursor = newest.id;
        lastPostAt = new Date(newest.date).toISOString();
        break;
      }
      if (new Date(newest.date).getTime() < staleBefore) {
        // Far behind (long downtime on a busy channel): this whole page is too
        // old to propose. Walk back from the latest page instead, stopping at
        // the first post that is too old or already seen.
        const floor = cursor;
        const recent: TmePost[] = [];
        let before: number | undefined;
        for (let back = 0; back < MAX_PAGES_PER_POLL; back += 1) {
          const latest = await fetchPage(source.handle, before === undefined ? { signal } : { before, signal });
          recent.push(...latest.posts.filter((post) => post.id > floor));
          const oldest = latest.posts[0];
          if (oldest === undefined || oldest.id <= floor + 1 || new Date(oldest.date).getTime() < staleBefore) break;
          before = oldest.id;
        }
        recent.sort((left, right) => left.id - right.id);
        accept(recent);
        break;
      }
      accept(fresh);
      if (fresh.length < 10) break;
    }
    store.markSourceChecked(source.id, { cursor, title, lastPostAt });
    return { handle: source.handle, stored, error: null };
  } catch (cause) {
    if (signal.aborted) throw cause;
    const message = cause instanceof TmeError || cause instanceof Error ? cause.message : String(cause);
    store.markSourceError(source.id, message);
    return { handle: source.handle, stored: 0, error: message };
  }
}

/**
 * Checks that a channel can be read and returns where to start: at its latest
 * post, so only what appears after this moment is collected.
 */
export async function probeSource(
  handle: string,
  signal?: AbortSignal,
  fetchPage: PageFetcher = fetchChannelPage,
): Promise<{ title: string | null; cursor: number; posts: number }> {
  const page = await fetchPage(handle, { signal });
  const newest = page.posts[page.posts.length - 1];
  return { title: page.title, cursor: newest === undefined ? 0 : newest.id, posts: page.posts.length };
}
