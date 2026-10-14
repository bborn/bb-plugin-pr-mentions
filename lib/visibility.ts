// Only private repositories are watched. On a public repository anyone can
// open issues and PRs and write comments, and an agent acting there reads
// that text with your permissions.
import { GitHubError, type GitHubClient } from "./github.js";

const TTL_MS = 60 * 60_000;

export type Visibility = "private" | "public" | "no-access";

export class RepoVisibility {
  private readonly cache = new Map<string, { value: Visibility; at: number }>();

  constructor(
    private readonly github: Pick<GitHubClient, "repo">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cached for an hour; a repository made public stops being watched within that time. */
  async of(slug: string, signal?: AbortSignal): Promise<Visibility> {
    const hit = this.cache.get(slug);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    let value: Visibility;
    try {
      value = (await this.github.repo(slug, signal)).private ? "private" : "public";
    } catch (error) {
      // 404: the token cannot see it. Anything else (rate limit, network) is
      // not an answer, so do not cache it.
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      value = "no-access";
    }
    this.cache.set(slug, { value, at: this.now() });
    return value;
  }

  /** Splits `slugs` into the private ones and the rest, with the reason. */
  async partition(
    slugs: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ watched: string[]; skipped: Map<string, Visibility> }> {
    const watched: string[] = [];
    const skipped = new Map<string, Visibility>();
    for (const slug of slugs) {
      const value = await this.of(slug, signal);
      if (value === "private") watched.push(slug);
      else skipped.set(slug, value);
    }
    return { watched, skipped };
  }
}
