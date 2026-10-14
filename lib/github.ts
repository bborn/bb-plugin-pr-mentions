// A small GitHub REST client. Polling uses conditional requests (ETag), and
// GitHub does not count a 304 against the rate limit, so idle polling of many
// repositories is close to free.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API = "https://api.github.com";
const TOKEN_TTL_MS = 10 * 60_000;

export interface GitHubUser {
  login: string;
  type?: string;
}

export interface IssueComment {
  id: number;
  html_url: string;
  issue_url: string;
  body: string | null;
  user: GitHubUser | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewComment {
  id: number;
  html_url: string;
  pull_request_url: string;
  body: string | null;
  user: GitHubUser | null;
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  in_reply_to_id?: number;
  created_at: string;
  updated_at: string;
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}

export interface Issue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  user: GitHubUser | null;
  pull_request?: unknown;
}

export interface Repository {
  full_name: string;
  private: boolean;
}

export interface UserEvent {
  id: string;
  type: string;
  created_at: string;
  repo: { name: string };
  payload: {
    action?: string;
    review?: {
      id: number;
      body: string | null;
      html_url: string;
      state: string;
      user: GitHubUser | null;
      submitted_at?: string;
    };
    pull_request?: { number: number; title?: string; html_url?: string };
  };
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface ConditionalResult<T> {
  status: 200 | 304;
  etag: string | null;
  data: T | null;
}

export class GitHubClient {
  private cachedToken: { value: string; at: number } | null = null;
  private viewer: string | null = null;

  /** `configuredToken` wins; otherwise the server machine's `gh auth token`. */
  constructor(private readonly configuredToken: () => Promise<string>) {}

  async token(): Promise<string> {
    const configured = (await this.configuredToken()).trim();
    if (configured !== "") return configured;
    if (this.cachedToken && Date.now() - this.cachedToken.at < TOKEN_TTL_MS) {
      return this.cachedToken.value;
    }
    let value: string;
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], {
        timeout: 15_000,
      });
      value = stdout.trim();
    } catch (error) {
      throw new GitHubError(
        `No GitHub token: set githubToken or sign in with \`gh auth login\` on the bb server machine (${(error as Error).message})`,
        401,
      );
    }
    if (value === "") throw new GitHubError("`gh auth token` printed nothing", 401);
    this.cachedToken = { value, at: Date.now() };
    return value;
  }

  /** Drop cached identity after an auth failure so the next call re-reads it. */
  resetAuth(): void {
    this.cachedToken = null;
    this.viewer = null;
  }

  async viewerLogin(signal?: AbortSignal): Promise<string> {
    if (this.viewer) return this.viewer;
    const user = await this.json<GitHubUser>("GET", "/user", undefined, signal);
    this.viewer = user.login;
    return user.login;
  }

  private async request(
    method: string,
    path: string,
    init: { body?: unknown; etag?: string | null; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${await this.token()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bb-plugin-pr-mentions",
    };
    if (init.etag) headers["If-None-Match"] = init.etag;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (response.status === 401) this.resetAuth();
    return response;
  }

  private async fail(response: Response, path: string): Promise<never> {
    const text = (await response.text()).slice(0, 300);
    throw new GitHubError(
      `GitHub ${response.status} for ${path}: ${text}`,
      response.status,
    );
  }

  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(method, path, { body, signal });
    if (!response.ok) return this.fail(response, path);
    return (await response.json()) as T;
  }

  async conditional<T>(
    path: string,
    etag: string | null,
    signal?: AbortSignal,
  ): Promise<ConditionalResult<T>> {
    const response = await this.request("GET", path, { etag, signal });
    if (response.status === 304) return { status: 304, etag, data: null };
    if (!response.ok) return this.fail(response, path);
    return {
      status: 200,
      etag: response.headers.get("etag"),
      data: (await response.json()) as T,
    };
  }

  pull(slug: string, number: number, signal?: AbortSignal): Promise<PullRequest> {
    return this.json("GET", `/repos/${slug}/pulls/${number}`, undefined, signal);
  }

  repo(slug: string, signal?: AbortSignal): Promise<Repository> {
    return this.json("GET", `/repos/${slug}`, undefined, signal);
  }

  issue(slug: string, number: number, signal?: AbortSignal): Promise<Issue> {
    return this.json("GET", `/repos/${slug}/issues/${number}`, undefined, signal);
  }

  /**
   * Answers a mention where it was made: in the review thread for an inline
   * comment, otherwise on the PR or issue's conversation.
   */
  async reply(
    mention: { kind: string; slug: string; number: number; commentId: number },
    body: string,
  ): Promise<{ html_url: string }> {
    const path =
      mention.kind === "review-comment"
        ? `/repos/${mention.slug}/pulls/${mention.number}/comments/${mention.commentId}/replies`
        : `/repos/${mention.slug}/issues/${mention.number}/comments`;
    return this.json("POST", path, { body });
  }

  /** Adds an emoji reaction; GitHub answers 200 when it already exists. */
  async react(
    slug: string,
    kind: "issue-comment" | "review-comment",
    commentId: number,
    content: "eyes" | "rocket" | "confused",
  ): Promise<void> {
    const segment = kind === "issue-comment" ? "issues" : "pulls";
    await this.json(
      "POST",
      `/repos/${slug}/${segment}/comments/${commentId}/reactions`,
      { content },
    );
  }
}
