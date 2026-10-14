// Deciding which BB thread a mention goes to, then sending it there.
//
// Order: the thread this PR was routed to before → a thread whose environment
// is on the PR's head branch, in any project for that repository → a new
// thread in the first project for that repository.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { GitHubClient } from "./github.js";
import { formatMessage, threadTitle } from "./message.js";
import { githubSlugFromRemote } from "./repo.js";
import type { Store } from "./store.js";
import type { Mention, MentionStatus } from "./types.js";

type Sdk = Pick<PluginBbSdk, "projects" | "threads">;
type ThreadSummary = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];
type TargetThread = Pick<ThreadSummary, "id" | "archivedAt" | "updatedAt">;

export interface RouteOptions {
  trigger: string;
  replyOnGitHub: boolean;
  spawnNewThreads: boolean;
  /** "worktree": a fresh BB worktree based on the PR branch; else the project's default. */
  newThreadEnvironment: "worktree" | "project-default";
  /** Lowercased logins whose PRs and issues BB may work on: you and allowedUsers. */
  trustedAuthors: ReadonlySet<string>;
  /** Also work on PRs and issues opened by others, and on PRs from forks. */
  actOnOthersWork: boolean;
}

export interface RouteResult {
  status: Exclude<MentionStatus, "pending" | "error">;
  threadId: string | null;
  detail: string;
}

const PAGE = 200;
const MAX_THREADS_SCANNED = 2000;

/** Projects by GitHub repository slug, for every project with a github.com remote. */
export async function projectsBySlug(sdk: Sdk): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const project of await sdk.projects.list()) {
    const slug = githubSlugFromRemote(project.gitRemoteUrl);
    if (!slug) continue;
    map.set(slug, [...(map.get(slug) ?? []), project.id]);
  }
  return map;
}

/**
 * The best thread on `branch` among `threads`: unarchived before archived,
 * then most recently updated.
 */
export function pickBranchThread(
  threads: readonly ThreadSummary[],
  branch: string,
): ThreadSummary | null {
  const candidates = threads.filter(
    (thread) =>
      thread.deletedAt === null && thread.environmentBranchName === branch,
  );
  candidates.sort((a, b) => {
    const archived = Number(a.archivedAt !== null) - Number(b.archivedAt !== null);
    return archived !== 0 ? archived : b.updatedAt - a.updatedAt;
  });
  return candidates[0] ?? null;
}

/** The machine holding the project's default checkout, where a worktree can be made. */
async function defaultHostId(sdk: Sdk, projectId: string): Promise<string | null> {
  const project = (await sdk.projects.list()).find((p) => p.id === projectId);
  const sources = project?.sources ?? [];
  return (sources.find((source) => source.isDefault) ?? sources[0])?.hostId ?? null;
}

export async function listProjectThreads(
  sdk: Pick<Sdk, "threads">,
  projectId: string,
  archivedStates: readonly boolean[] = [false, true],
): Promise<ThreadSummary[]> {
  const all: ThreadSummary[] = [];
  for (const archived of archivedStates) {
    for (let offset = 0; offset < MAX_THREADS_SCANNED; offset += PAGE) {
      const page = await sdk.threads.list({
        projectId,
        archived,
        includeHidden: true,
        limit: PAGE,
        offset,
      });
      all.push(...page);
      if (page.length < PAGE) break;
    }
  }
  return all;
}

export class Router {
  constructor(
    private readonly sdk: Sdk,
    private readonly github: GitHubClient,
    private readonly store: Store,
  ) {}

  async route(
    mention: Mention,
    projectIds: readonly string[],
    options: RouteOptions,
  ): Promise<RouteResult> {
    if (projectIds.length === 0) {
      return {
        status: "unrouted",
        threadId: null,
        detail: `no BB project has ${mention.slug} as its git remote`,
      };
    }

    const issue = await this.github.issue(mention.slug, mention.number);
    const isPull = issue.pull_request !== undefined;
    const noun = isPull ? "PR" : "issue";
    let headRef: string | null = null;
    let defaultBranches = new Set<string>();
    let fromFork = false;
    if (isPull) {
      const pull = await this.github.pull(mention.slug, mention.number);
      // A fork's branch name means nothing in this repository's checkouts.
      const sameRepo =
        pull.head.repo?.full_name.toLowerCase() === mention.slug;
      fromFork = !sameRepo;
      headRef = sameRepo ? pull.head.ref : null;
      defaultBranches = new Set([pull.base.ref]);
    }

    // The agent reads the PR's code and text with your permissions, so by
    // default it only works on things you (or allowedUsers) opened.
    if (!options.actOnOthersWork) {
      const opener = issue.user?.login ?? "a deleted user";
      if (!options.trustedAuthors.has(opener.toLowerCase())) {
        return {
          status: "refused",
          threadId: null,
          detail: `${noun} opened by @${opener}; turn on "Act on PRs and issues opened by others" to allow`,
        };
      }
      if (fromFork) {
        return {
          status: "refused",
          threadId: null,
          detail: `PR from a fork; turn on "Act on PRs and issues opened by others" to allow`,
        };
      }
    }

    const existing = await this.linkedThread(mention);
    let target: TargetThread | null = existing;
    if (!target && headRef && !defaultBranches.has(headRef)) {
      for (const projectId of projectIds) {
        const found = pickBranchThread(
          await listProjectThreads(this.sdk, projectId),
          headRef,
        );
        if (found && (!target || found.updatedAt > target.updatedAt)) target = found;
      }
    }

    if (target) {
      if (target.archivedAt !== null) {
        await this.sdk.threads.unarchive({ threadId: target.id });
      }
      const text = formatMessage(mention, {
        title: issue.title,
        isPull,
        headRef,
        newThread: false,
        replyOnGitHub: options.replyOnGitHub,
        trigger: options.trigger,
      });
      await this.sdk.threads.send({
        threadId: target.id,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
      this.store.setLink(mention.slug, mention.number, target.id);
      return {
        status: "delivered",
        threadId: target.id,
        detail: existing
          ? "sent to the thread linked to this PR"
          : `sent to the thread on branch ${headRef}`,
      };
    }

    if (!options.spawnNewThreads) {
      return {
        status: "unrouted",
        threadId: null,
        detail: "no thread found and spawnNewThreads is off",
      };
    }

    const projectId = projectIds[0]!;
    const hostId =
      options.newThreadEnvironment === "worktree" ? await defaultHostId(this.sdk, projectId) : null;
    const spawn = (baseBranch: { kind: "named"; name: string } | { kind: "default" }) =>
      this.sdk.threads.spawn({
        projectId,
        environment: hostId
          ? { type: "host", hostId, workspace: { type: "managed-worktree", baseBranch } }
          : { type: "project-default" },
        title: threadTitle(mention, issue.title, isPull),
        prompt: formatMessage(mention, {
          title: issue.title,
          isPull,
          headRef,
          newThread: true,
          replyOnGitHub: options.replyOnGitHub,
          trigger: options.trigger,
        }),
        pluginMetadata: {
          repo: mention.slug,
          number: mention.number,
          url: issue.html_url,
        },
      });
    let thread: { id: string };
    try {
      thread = await spawn(
        headRef ? { kind: "named", name: `origin/${headRef}` } : { kind: "default" },
      );
    } catch (error) {
      // The PR branch may not be fetched in the project's checkout yet. The
      // prompt starts with `gh pr checkout`, so the default base works too.
      if (!headRef || !hostId) throw error;
      thread = await spawn({ kind: "default" });
    }
    this.store.setLink(mention.slug, mention.number, thread.id);
    return {
      status: "spawned",
      threadId: thread.id,
      detail: `started a new thread in project ${projectId}`,
    };
  }

  /** The thread a previous mention on this PR went to, if it still exists. */
  private async linkedThread(mention: Mention): Promise<TargetThread | null> {
    const threadId = this.store.link(mention.slug, mention.number);
    if (!threadId) return null;
    try {
      const thread = await this.sdk.threads.get({ threadId });
      if (thread.deletedAt === null) return thread;
    } catch {
      // Deleted or unreadable: fall through and re-link.
    }
    this.store.removeLink(mention.slug, mention.number);
    return null;
  }
}
