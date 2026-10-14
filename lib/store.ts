// Plugin-owned state in the plugin's SQLite database: the mention log (also
// the dedupe set), PR → thread links, and per-feed poll cursors.
import type Database from "better-sqlite3";
import type { Mention, MentionStatus } from "./types.js";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS mentions (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    author TEXT NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL,
    thread_id TEXT,
    detail TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    handled_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS links (
    pr TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cursors (
    key TEXT PRIMARY KEY,
    since TEXT NOT NULL,
    etag TEXT
  )`,
];

export interface MentionRow {
  key: string;
  kind: string;
  slug: string;
  number: number;
  url: string;
  author: string;
  instruction: string;
  status: MentionStatus;
  thread_id: string | null;
  detail: string | null;
  attempts: number;
  created_at: string;
  handled_at: number;
  payload: string;
}

export interface Cursor {
  since: string;
  etag: string | null;
}

export const MAX_ATTEMPTS = 3;

export function prKey(slug: string, number: number): string {
  return `${slug}#${number}`;
}

export class Store {
  constructor(private readonly db: Database.Database) {}

  /** True when this mention was already handled (or gave up retrying). */
  isDone(key: string): boolean {
    const row = this.db
      .prepare(`SELECT status, attempts FROM mentions WHERE key = ?`)
      .get(key) as { status: string; attempts: number } | undefined;
    if (!row) return false;
    return row.status !== "error" || row.attempts >= MAX_ATTEMPTS;
  }

  record(
    mention: Mention,
    status: MentionStatus,
    threadId: string | null,
    detail: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO mentions (key, kind, slug, number, url, author, instruction, status, thread_id, detail, attempts, created_at, handled_at, payload)
         VALUES (@key, @kind, @slug, @number, @url, @author, @instruction, @status, @threadId, @detail, 1, @createdAt, @now, @payload)
         ON CONFLICT(key) DO UPDATE SET status = @status, thread_id = @threadId, detail = @detail,
           attempts = attempts + 1, handled_at = @now`,
      )
      .run({
        key: mention.key,
        kind: mention.kind,
        slug: mention.slug,
        number: mention.number,
        url: mention.url,
        author: mention.author,
        instruction: mention.instruction,
        status,
        threadId,
        detail,
        createdAt: mention.createdAt,
        now: Date.now(),
        payload: JSON.stringify(mention),
      });
  }

  /**
   * Queues mentions to be handled again on the next poll: the one with this
   * comment URL whatever its status, or with no URL every failed one.
   */
  requeue(url?: string): number {
    const result =
      url === undefined
        ? this.db.prepare(`UPDATE mentions SET attempts = 0 WHERE status = 'error'`).run()
        : this.db
            .prepare(`UPDATE mentions SET status = 'error', attempts = 0 WHERE url = ?`)
            .run(url);
    return result.changes;
  }

  /** Mentions that failed and still have attempts left. */
  retryable(): Mention[] {
    const rows = this.db
      .prepare(`SELECT payload FROM mentions WHERE status = 'error' AND attempts < ?`)
      .all(MAX_ATTEMPTS) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as Mention);
  }

  /** The mention with this comment URL, or else the latest one sent to `threadId`. */
  find(
    url: string | undefined,
    threadId: string | undefined,
  ): { mention: Mention; threadId: string | null } | null {
    const row = (
      url !== undefined
        ? this.db.prepare(`SELECT payload, thread_id FROM mentions WHERE url = ?`).get(url)
        : this.db
            .prepare(
              `SELECT payload, thread_id FROM mentions WHERE thread_id = ? ORDER BY handled_at DESC LIMIT 1`,
            )
            .get(threadId ?? "")
    ) as { payload: string; thread_id: string | null } | undefined;
    return row
      ? { mention: JSON.parse(row.payload) as Mention, threadId: row.thread_id }
      : null;
  }

  recent(limit: number): MentionRow[] {
    return this.db
      .prepare(`SELECT * FROM mentions ORDER BY handled_at DESC LIMIT ?`)
      .all(limit) as MentionRow[];
  }

  link(slug: string, number: number): string | null {
    const row = this.db
      .prepare(`SELECT thread_id FROM links WHERE pr = ?`)
      .get(prKey(slug, number)) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }

  setLink(slug: string, number: number, threadId: string): void {
    this.db
      .prepare(
        `INSERT INTO links (pr, thread_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(pr) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
      )
      .run(prKey(slug, number), threadId, Date.now());
  }

  removeLink(slug: string, number: number): boolean {
    return (
      this.db.prepare(`DELETE FROM links WHERE pr = ?`).run(prKey(slug, number))
        .changes > 0
    );
  }

  links(): { pr: string; thread_id: string; updated_at: number }[] {
    return this.db
      .prepare(`SELECT * FROM links ORDER BY updated_at DESC`)
      .all() as { pr: string; thread_id: string; updated_at: number }[];
  }

  cursor(key: string): Cursor | null {
    const row = this.db
      .prepare(`SELECT since, etag FROM cursors WHERE key = ?`)
      .get(key) as Cursor | undefined;
    return row ?? null;
  }

  setCursor(key: string, cursor: Cursor): void {
    this.db
      .prepare(
        `INSERT INTO cursors (key, since, etag) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET since = excluded.since, etag = excluded.etag`,
      )
      .run(key, cursor.since, cursor.etag);
  }
}
