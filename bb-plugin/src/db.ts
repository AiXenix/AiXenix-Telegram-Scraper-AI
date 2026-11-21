// Database layer: sources, collected posts, stories (one story = one piece of
// news, however many channels carried it), small key-value state and an event
// log. It talks to SQLite through a minimal interface that both better-sqlite3
// (inside bb) and node:sqlite (the standalone script) satisfy.

export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  exec(sql: string): unknown;
}

/** Append-only: never edit or reorder shipped statements, only add new ones. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE sources (
     id INTEGER PRIMARY KEY,
     handle TEXT NOT NULL UNIQUE,
     title TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     backend TEXT NOT NULL DEFAULT 'web',
     cursor INTEGER NOT NULL DEFAULT 0,
     last_checked_at TEXT,
     last_post_at TEXT,
     last_error TEXT,
     error_count INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE stories (
     id INTEGER PRIMARY KEY,
     status TEXT NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     score INTEGER,
     reason TEXT,
     tokens TEXT NOT NULL DEFAULT '',
     link_keys TEXT NOT NULL DEFAULT '',
     draft_html TEXT,
     draft_version INTEGER NOT NULL DEFAULT 0,
     draft_note TEXT,
     media_post_id INTEGER,
     manual INTEGER NOT NULL DEFAULT 0,
     proposal_media TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     decision_reason TEXT,
     decided_at TEXT,
     published_at TEXT,
     published_url TEXT,
     proposal_chat_id INTEGER,
     proposal_message_ids TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX stories_status ON stories(status, created_at)`,
  `CREATE TABLE posts (
     id INTEGER PRIMARY KEY,
     source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
     source_handle TEXT NOT NULL,
     msg_id INTEGER NOT NULL,
     url TEXT NOT NULL,
     posted_at TEXT NOT NULL,
     text TEXT NOT NULL,
     media_json TEXT NOT NULL DEFAULT '[]',
     links_json TEXT NOT NULL DEFAULT '[]',
     fwd_from TEXT,
     fingerprint TEXT NOT NULL,
     story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL,
     state TEXT NOT NULL DEFAULT 'new',
     skip_reason TEXT,
     created_at TEXT NOT NULL,
     UNIQUE(source_handle, msg_id)
   )`,
  `CREATE INDEX posts_state ON posts(state, posted_at)`,
  `CREATE INDEX posts_story ON posts(story_id)`,
  `CREATE INDEX posts_fingerprint ON posts(fingerprint)`,
  `CREATE TABLE own_posts (
     msg_id INTEGER PRIMARY KEY,
     posted_at TEXT NOT NULL,
     text TEXT NOT NULL,
     story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL
   )`,
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     level TEXT NOT NULL,
     kind TEXT NOT NULL,
     message TEXT NOT NULL,
     story_id INTEGER
   )`,
  `CREATE INDEX events_at ON events(at)`,
  `CREATE TABLE llm_runs (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     task TEXT NOT NULL,
     model TEXT NOT NULL,
     thread_id TEXT,
     ok INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     error TEXT
   )`,
  `CREATE TABLE state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `ALTER TABLE stories ADD COLUMN duplicate_of INTEGER`,
];

/**
 * Applies pending migrations, tracking progress in PRAGMA user_version. The
 * standalone script uses this; inside bb the host's own migrator does the job.
 */
export function migrate(db: SqlDb): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let index = Number(row.user_version); index < MIGRATIONS.length; index += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[index] as string);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
  }
}

export type StoryStatus =
  | "candidate" // passed the filter, waiting for a draft
  | "proposed" // draft ready, waiting for the owner's decision
  | "publishing" // approved, being sent to the channel
  | "published"
  | "rejected" // the owner said no
  | "filtered" // the filter dropped it
  | "own" // already on the channel before this plugin saw it
  | "failed"; // drafting or publishing kept failing

export interface SourceRow {
  id: number;
  handle: string;
  title: string | null;
  enabled: number;
  backend: string;
  cursor: number;
  last_checked_at: string | null;
  last_post_at: string | null;
  last_error: string | null;
  error_count: number;
  created_at: string;
}

export interface StoryRow {
  id: number;
  status: StoryStatus;
  title: string;
  summary: string;
  score: number | null;
  reason: string | null;
  tokens: string;
  link_keys: string;
  draft_html: string | null;
  draft_version: number;
  /** The writer's own remark about the draft: doubts about facts, missing media. */
  draft_note: string | null;
  media_post_id: number | null;
  /** 1 when the owner forwarded the source post to the bot by hand. */
  manual: number;
  /** JSON list of Telegram file ids from the preview, reused when publishing. */
  proposal_media: string | null;
  attempts: number;
  last_error: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  published_at: string | null;
  published_url: string | null;
  proposal_chat_id: number | null;
  proposal_message_ids: string | null;
  /** For a repeat that was dropped: the story it repeats. */
  duplicate_of: number | null;
  created_at: string;
  updated_at: string;
}

export interface PostRow {
  id: number;
  source_id: number | null;
  source_handle: string;
  msg_id: number;
  url: string;
  posted_at: string;
  text: string;
  media_json: string;
  links_json: string;
  fwd_from: string | null;
  fingerprint: string;
  story_id: number | null;
  state: "new" | "done" | "skipped";
  skip_reason: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  at: string;
  level: "info" | "warn" | "error";
  kind: string;
  message: string;
  story_id: number | null;
}

export const nowIso = (): string => new Date().toISOString();

export class Store {
  readonly db: SqlDb;
  constructor(db: SqlDb) {
    this.db = db;
  }

  // ---- small state -------------------------------------------------------

  getState<T>(key: string): T | null {
    const row = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as { value: string } | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }
  setState(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value));
  }
  deleteState(key: string): void {
    this.db.prepare(`DELETE FROM state WHERE key = ?`).run(key);
  }

  // ---- sources -----------------------------------------------------------

  listSources(): SourceRow[] {
    return this.db.prepare(`SELECT * FROM sources ORDER BY handle`).all() as SourceRow[];
  }
  getSource(id: number): SourceRow | undefined {
    return this.db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as SourceRow | undefined;
  }
  getSourceByHandle(handle: string): SourceRow | undefined {
    return this.db.prepare(`SELECT * FROM sources WHERE handle = ?`).get(handle) as SourceRow | undefined;
  }
  addSource(handle: string, title: string | null, cursor: number): SourceRow {
    const info = this.db
      .prepare(`INSERT INTO sources (handle, title, cursor, created_at) VALUES (?, ?, ?, ?)`)
      .run(handle, title, cursor, nowIso());
    return this.getSource(Number(info.lastInsertRowid)) as SourceRow;
  }
  setSourceEnabled(id: number, enabled: boolean): void {
    this.db.prepare(`UPDATE sources SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  }
  /** Removes a source together with its posts nobody has looked at yet; decided stories keep their posts. */
  removeSource(id: number): void {
    const source = this.getSource(id);
    if (source === undefined) return;
    this.db.prepare(`DELETE FROM posts WHERE source_handle = ? AND state = 'new'`).run(source.handle);
    this.db.prepare(`DELETE FROM sources WHERE id = ?`).run(id);
  }
  markSourceChecked(id: number, patch: { cursor?: number; title?: string | null; lastPostAt?: string | null }): void {
    this.db
      .prepare(
        `UPDATE sources SET last_checked_at = ?, last_error = NULL, error_count = 0,
           cursor = COALESCE(?, cursor), title = COALESCE(?, title), last_post_at = COALESCE(?, last_post_at)
         WHERE id = ?`,
      )
      .run(nowIso(), patch.cursor ?? null, patch.title ?? null, patch.lastPostAt ?? null, id);
  }
  setSourceCursor(id: number, cursor: number): void {
    this.db.prepare(`UPDATE sources SET cursor = ?, last_error = NULL, error_count = 0 WHERE id = ?`).run(cursor, id);
  }
  markSourceError(id: number, message: string): number {
    this.db
      .prepare(`UPDATE sources SET last_checked_at = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?`)
      .run(nowIso(), message, id);
    return this.getSource(id)?.error_count ?? 0;
  }
  /** Per-source totals for the admin page: what was collected and how it ended. */
  sourceStats(): Map<string, { posts: number; published: number; rejected: number }> {
    const rows = this.db
      .prepare(
        `SELECT p.source_handle AS handle, COUNT(*) AS posts,
                SUM(CASE WHEN s.status = 'published' THEN 1 ELSE 0 END) AS published,
                SUM(CASE WHEN s.status = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM posts p LEFT JOIN stories s ON s.id = p.story_id GROUP BY p.source_handle`,
      )
      .all() as { handle: string; posts: number; published: number | null; rejected: number | null }[];
    return new Map(
      rows.map((row) => [row.handle, { posts: row.posts, published: row.published ?? 0, rejected: row.rejected ?? 0 }]),
    );
  }

  // ---- posts -------------------------------------------------------------

  /** Returns false when this post was already stored. */
  insertPost(post: Omit<PostRow, "id" | "story_id" | "state" | "skip_reason" | "created_at">): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO posts
           (source_id, source_handle, msg_id, url, posted_at, text, media_json, links_json, fwd_from, fingerprint, created_at)
         VALUES (@source_id, @source_handle, @msg_id, @url, @posted_at, @text, @media_json, @links_json, @fwd_from, @fingerprint, @created_at)`,
      )
      .run({ ...post, created_at: nowIso() });
    return Number(info.changes) > 0;
  }
  getPost(id: number): PostRow | undefined {
    return this.db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as PostRow | undefined;
  }
  getPostByRef(sourceHandle: string, msgId: number): PostRow | undefined {
    return this.db
      .prepare(`SELECT * FROM posts WHERE source_handle = ? AND msg_id = ?`)
      .get(sourceHandle, msgId) as PostRow | undefined;
  }
  newPosts(limit: number): PostRow[] {
    return this.db
      .prepare(`SELECT * FROM posts WHERE state = 'new' ORDER BY posted_at ASC, id ASC LIMIT ?`)
      .all(limit) as PostRow[];
  }
  countNewPosts(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE state = 'new'`).get() as { n: number }).n;
  }
  /** Posts of a story, including the posts of its dropped repeats: everything the channels wrote about it. */
  postsOfStory(storyId: number): PostRow[] {
    return this.db
      .prepare(
        `SELECT * FROM posts
         WHERE story_id = ? OR story_id IN (SELECT id FROM stories WHERE duplicate_of = ?)
         ORDER BY posted_at ASC, id ASC`,
      )
      .all(storyId, storyId) as PostRow[];
  }
  findPostByFingerprint(fingerprint: string, exceptId: number): PostRow | undefined {
    return this.db
      .prepare(`SELECT * FROM posts WHERE fingerprint = ? AND id <> ? AND story_id IS NOT NULL ORDER BY id ASC LIMIT 1`)
      .get(fingerprint, exceptId) as PostRow | undefined;
  }
  settlePost(id: number, patch: { storyId?: number | null; state: "done" | "skipped"; skipReason?: string | null }): void {
    this.db
      .prepare(`UPDATE posts SET state = ?, story_id = COALESCE(?, story_id), skip_reason = ? WHERE id = ?`)
      .run(patch.state, patch.storyId ?? null, patch.skipReason ?? null, id);
  }

  // ---- stories -----------------------------------------------------------

  createStory(story: {
    status: StoryStatus;
    title: string;
    summary: string;
    score?: number | null;
    reason?: string | null;
    tokens: string[];
    linkKeys: string[];
    manual?: boolean;
    duplicateOf?: number | null;
    createdAt?: string;
  }): StoryRow {
    const at = story.createdAt ?? nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO stories (status, title, summary, score, reason, tokens, link_keys, manual, duplicate_of, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        story.status,
        story.title,
        story.summary,
        story.score ?? null,
        story.reason ?? null,
        story.tokens.join(" "),
        story.linkKeys.join(" "),
        story.manual === true ? 1 : 0,
        story.duplicateOf ?? null,
        at,
        nowIso(),
      );
    return this.getStory(Number(info.lastInsertRowid)) as StoryRow;
  }
  getStory(id: number): StoryRow | undefined {
    return this.db.prepare(`SELECT * FROM stories WHERE id = ?`).get(id) as StoryRow | undefined;
  }
  updateStory(id: number, patch: Partial<Omit<StoryRow, "id" | "created_at" | "updated_at">>): StoryRow {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
      this.db
        .prepare(`UPDATE stories SET ${assignments}, updated_at = @updated_at WHERE id = @id`)
        .run({ ...patch, id, updated_at: nowIso() });
    }
    return this.getStory(id) as StoryRow;
  }
  /** Moves a story between statuses only if it is still in one of the expected ones. */
  transition(id: number, from: StoryStatus[], to: StoryStatus): boolean {
    const marks = from.map(() => "?").join(", ");
    const info = this.db
      .prepare(`UPDATE stories SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`)
      .run(to, nowIso(), id, ...from);
    return Number(info.changes) > 0;
  }
  listStories(filter: { statuses: StoryStatus[]; limit: number; offset: number; query?: string }): StoryRow[] {
    const marks = filter.statuses.map(() => "?").join(", ");
    const like = filter.query === undefined || filter.query.trim() === "" ? null : `%${filter.query.trim()}%`;
    return this.db
      .prepare(
        `SELECT * FROM stories WHERE status IN (${marks})
           AND (? IS NULL OR title LIKE ? OR summary LIKE ? OR draft_html LIKE ?)
         ORDER BY COALESCE(decided_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...filter.statuses, like, like, like, like, filter.limit, filter.offset) as StoryRow[];
  }
  countByStatus(): Record<string, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM stories GROUP BY status`).all() as {
      status: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }
  /** Stories young enough to be the "same news" as something collected now. */
  recentStories(sinceIso: string): StoryRow[] {
    return this.db.prepare(`SELECT * FROM stories WHERE created_at >= ? ORDER BY id DESC`).all(sinceIso) as StoryRow[];
  }
  nextCandidates(limit: number): StoryRow[] {
    return this.db
      .prepare(`SELECT * FROM stories WHERE status = 'candidate' ORDER BY COALESCE(score, 0) DESC, id ASC LIMIT ?`)
      .all(limit) as StoryRow[];
  }
  proposedSince(sinceIso: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM stories
           WHERE status IN ('proposed', 'publishing', 'published', 'rejected') AND draft_version > 0 AND created_at >= ?`,
        )
        .get(sinceIso) as { n: number }
    ).n;
  }
  unsentProposals(): StoryRow[] {
    return this.db
      .prepare(`SELECT * FROM stories WHERE status = 'proposed' AND proposal_message_ids IS NULL ORDER BY id ASC LIMIT 10`)
      .all() as StoryRow[];
  }

  /**
   * Forgets everything collected and decided so far: posts, proposals, the
   * filtered list. What is already on the owner's channel stays, so it still
   * blocks repeats.
   */
  clearWork(): { stories: number; posts: number } {
    const posts = Number(this.db.prepare(`DELETE FROM posts`).run().changes);
    // What went out to the channel is now simply a post of the channel: it keeps blocking repeats.
    this.db.prepare(`UPDATE stories SET status = 'own', duplicate_of = NULL WHERE status = 'published'`).run();
    const stories = Number(this.db.prepare(`DELETE FROM stories WHERE status <> 'own'`).run().changes);
    this.db.prepare(`UPDATE own_posts SET story_id = NULL WHERE story_id NOT IN (SELECT id FROM stories)`).run();
    return { stories, posts };
  }

  // ---- own channel -------------------------------------------------------

  hasOwnPost(msgId: number): boolean {
    return this.db.prepare(`SELECT 1 FROM own_posts WHERE msg_id = ?`).get(msgId) !== undefined;
  }
  addOwnPost(msgId: number, postedAt: string, text: string, storyId: number | null): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO own_posts (msg_id, posted_at, text, story_id) VALUES (?, ?, ?, ?)`)
      .run(msgId, postedAt, text, storyId);
  }
  maxOwnPostId(): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(msg_id), 0) AS n FROM own_posts`).get() as { n: number }).n;
  }
  countOwnPosts(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM own_posts`).get() as { n: number }).n;
  }
  recentOwnTexts(limit: number, minLength: number): string[] {
    const rows = this.db
      .prepare(`SELECT text FROM own_posts WHERE LENGTH(text) >= ? ORDER BY msg_id DESC LIMIT ?`)
      .all(minLength, limit) as { text: string }[];
    return rows.map((row) => row.text);
  }

  // ---- log ---------------------------------------------------------------

  logEvent(level: EventRow["level"], kind: string, message: string, storyId: number | null = null): void {
    this.db
      .prepare(`INSERT INTO events (at, level, kind, message, story_id) VALUES (?, ?, ?, ?, ?)`)
      .run(nowIso(), level, kind, message.slice(0, 1000), storyId);
  }
  recentEvents(limit: number, minLevel: "info" | "warn" = "info"): EventRow[] {
    const levels = minLevel === "warn" ? ["warn", "error"] : ["info", "warn", "error"];
    const marks = levels.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM events WHERE level IN (${marks}) ORDER BY id DESC LIMIT ?`)
      .all(...levels, limit) as EventRow[];
  }
  logLlmRun(run: { task: string; model: string; threadId: string | null; ok: boolean; durationMs: number; error?: string }): void {
    this.db
      .prepare(`INSERT INTO llm_runs (at, task, model, thread_id, ok, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(nowIso(), run.task, run.model, run.threadId, run.ok ? 1 : 0, run.durationMs, run.error ?? null);
  }
  llmStats(sinceIso: string): { task: string; model: string; runs: number; failed: number; avgMs: number }[] {
    return this.db
      .prepare(
        `SELECT task, model, COUNT(*) AS runs, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
                CAST(AVG(duration_ms) AS INTEGER) AS avgMs
         FROM llm_runs WHERE at >= ? GROUP BY task, model ORDER BY task`,
      )
      .all(sinceIso) as { task: string; model: string; runs: number; failed: number; avgMs: number }[];
  }
  /** Keeps the log tables from growing without bound. */
  prune(beforeIso: string): void {
    this.db.prepare(`DELETE FROM events WHERE at < ?`).run(beforeIso);
    this.db.prepare(`DELETE FROM llm_runs WHERE at < ?`).run(beforeIso);
  }
}
