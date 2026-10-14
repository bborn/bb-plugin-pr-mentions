// Polling GitHub for new comments that address the trigger.
//
// Per repository: issue comments (which include PR conversation comments) and
// inline review comments, each with an `updated_at` cursor and an ETag. Review
// summaries have no per-repository feed, so they come from the signed-in
// user's own event feed, which spans every repository they can see.
import type { GitHubClient, IssueComment, ReviewComment, UserEvent } from "./github.js";
import { parseMention } from "./mention.js";
import type { Store } from "./store.js";
import type { Mention } from "./types.js";

const PER_PAGE = 100;
const MAX_PAGES = 10;

export interface PollOptions {
  trigger: string;
  allowedUsers: readonly string[];
}

export interface PollSummary {
  repos: number;
  found: number;
}

export type MentionHandler = (mention: Mention) => Promise<void>;

/** Now as GitHub writes timestamps (whole seconds), so string order is time order. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/**
 * True when a comment changed after it was posted. Repository admins can edit
 * anyone's comment and the author stays the same, so an edited comment cannot
 * be trusted to say what its author wrote.
 */
export function wasEdited(comment: { created_at: string; updated_at: string }): boolean {
  return Date.parse(comment.updated_at) - Date.parse(comment.created_at) > 1000;
}

function issueNumber(url: string): number {
  return Number(/\/(?:issues|pulls)\/(\d+)$/u.exec(url)?.[1] ?? Number.NaN);
}

export function mentionFromIssueComment(
  slug: string,
  comment: IssueComment,
  trigger: string,
): Mention | null {
  if (wasEdited(comment)) return null;
  const parsed = parseMention(comment.body, trigger);
  const number = issueNumber(comment.issue_url);
  if (!parsed || !comment.user || !Number.isFinite(number)) return null;
  return {
    key: `issue-comment:${comment.id}`,
    kind: "issue-comment",
    commentId: comment.id,
    slug,
    number,
    url: comment.html_url,
    author: comment.user.login,
    instruction: parsed.instruction,
    createdAt: comment.created_at,
  };
}

export function mentionFromReviewComment(
  slug: string,
  comment: ReviewComment,
  trigger: string,
): Mention | null {
  if (wasEdited(comment)) return null;
  const parsed = parseMention(comment.body, trigger);
  const number = issueNumber(comment.pull_request_url);
  if (!parsed || !comment.user || !Number.isFinite(number)) return null;
  return {
    key: `review-comment:${comment.id}`,
    kind: "review-comment",
    commentId: comment.id,
    slug,
    number,
    url: comment.html_url,
    author: comment.user.login,
    instruction: parsed.instruction,
    createdAt: comment.created_at,
    code: {
      path: comment.path,
      line: comment.line ?? comment.original_line,
      diffHunk: comment.diff_hunk,
    },
  };
}

export class Poller {
  constructor(
    private readonly github: GitHubClient,
    private readonly store: Store,
    private readonly handle: MentionHandler,
  ) {}

  async pollOnce(
    slugs: readonly string[],
    options: PollOptions,
    signal?: AbortSignal,
  ): Promise<PollSummary> {
    const viewer = await this.github.viewerLogin(signal);
    const allowed = new Set(
      [viewer, ...options.allowedUsers].map((login) => login.toLowerCase()),
    );
    const accept = (mention: Mention | null): mention is Mention =>
      mention !== null &&
      allowed.has(mention.author.toLowerCase()) &&
      !this.store.isDone(mention.key);

    let found = 0;
    const deliver = async (mention: Mention) => {
      found += 1;
      await this.handle(mention);
    };

    for (const mention of this.store.retryable()) {
      if (signal?.aborted) break;
      await deliver(mention);
    }

    for (const slug of slugs) {
      if (signal?.aborted) break;
      await this.pollFeed<IssueComment>(
        `issues:${slug}`,
        `/repos/${slug}/issues/comments`,
        signal,
        async (comment) => {
          const mention = mentionFromIssueComment(slug, comment, options.trigger);
          if (accept(mention)) await deliver(mention);
        },
      );
      await this.pollFeed<ReviewComment>(
        `pulls:${slug}`,
        `/repos/${slug}/pulls/comments`,
        signal,
        async (comment) => {
          const mention = mentionFromReviewComment(slug, comment, options.trigger);
          if (accept(mention)) await deliver(mention);
        },
      );
    }

    if (!signal?.aborted) {
      await this.pollReviews(viewer, new Set(slugs), options.trigger, signal, async (mention) => {
        if (accept(mention)) await deliver(mention);
      });
    }
    return { repos: slugs.length, found };
  }

  /**
   * Reads one `since`-filtered list. The cursor only moves when something new
   * arrives, so the URL stays stable and repeat polls are 304s.
   */
  private async pollFeed<T extends { updated_at: string }>(
    key: string,
    path: string,
    signal: AbortSignal | undefined,
    visit: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = this.store.cursor(key);
    if (!cursor) {
      // First time this feed is seen: start from now, never replay history.
      this.store.setCursor(key, { since: nowIso(), etag: null });
      return;
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${path}?since=${encodeURIComponent(cursor.since)}&sort=updated&direction=asc&per_page=${PER_PAGE}`;
      const result = await this.github.conditional<T[]>(url, cursor.etag, signal);
      if (result.status === 304 || !result.data) return;
      let since: string = cursor.since;
      for (const item of result.data) {
        await visit(item);
        if (item.updated_at > since) since = item.updated_at;
      }
      if (since === cursor.since) {
        this.store.setCursor(key, { since, etag: result.etag });
        return;
      }
      cursor = { since, etag: null };
      this.store.setCursor(key, cursor);
      if (result.data.length < PER_PAGE) return;
    }
  }

  private async pollReviews(
    viewer: string,
    slugs: ReadonlySet<string>,
    trigger: string,
    signal: AbortSignal | undefined,
    visit: (mention: Mention | null) => Promise<void>,
  ): Promise<void> {
    const key = `events:${viewer.toLowerCase()}`;
    const cursor = this.store.cursor(key);
    if (!cursor) {
      this.store.setCursor(key, { since: nowIso(), etag: null });
      return;
    }
    const result = await this.github.conditional<UserEvent[]>(
      `/users/${viewer}/events?per_page=${PER_PAGE}`,
      cursor.etag,
      signal,
    );
    if (result.status === 304 || !result.data) return;
    let newest = cursor.since;
    const events = result.data
      .filter((event) => event.type === "PullRequestReviewEvent")
      .filter((event) => event.created_at >= cursor.since)
      .reverse();
    for (const event of events) {
      if (event.created_at > newest) newest = event.created_at;
      const slug = event.repo.name.toLowerCase();
      const number = event.payload.pull_request?.number;
      let review = event.payload.review;
      if (!slugs.has(slug) || !number || !review) continue;
      // Trimmed event payloads can omit the body; read the review itself.
      if (review.body === undefined || !review.user) {
        review = await this.github.json(
          "GET",
          `/repos/${slug}/pulls/${number}/reviews/${review.id}`,
          undefined,
          signal,
        );
      }
      const parsed = parseMention(review!.body, trigger);
      await visit(
        parsed && review!.user
          ? {
              key: `review:${review!.id}`,
              kind: "review",
              commentId: review!.id,
              slug,
              number,
              url: review!.html_url,
              author: review!.user.login,
              instruction: parsed.instruction,
              createdAt: event.created_at,
            }
          : null,
      );
    }
    this.store.setCursor(key, { since: newest, etag: result.etag });
  }
}
