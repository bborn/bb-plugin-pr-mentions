// Resolving (archiving) BB threads when their PR is merged.
//
// Only threads a GitHub mention was sent to are resolved. Each poll asks the
// repositories those mentions came from for their recently closed PRs (a
// conditional request; unchanged answers are free). A PR merged after this
// started watching the repository is remembered until its threads are dealt
// with: the threads its mentions went to, if they existed when it merged. Busy
// and pinned threads are left alone. Each thread is archived at most once, so
// one you reopen stays open.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { GitHubClient, PullRequest } from "./github.js";
import { listProjectThreads } from "./router.js";
import type { Store } from "./store.js";

type Sdk = Pick<PluginBbSdk, "threads">;
type ThreadSummary = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

/** Merged PRs whose threads are still busy are tried again for this long. */
export const PENDING_MS = 3 * 24 * 60 * 60_000;

export interface MergedPr {
  slug: string;
  number: number;
  headRef: string;
  mergedAt: number;
}

export interface ResolveResult {
  archived: { threadId: string; pr: string }[];
}

/** Busy threads are left alone and tried again on the next poll. */
export function isBusy(thread: ThreadSummary): boolean {
  const activity = thread.activity;
  return (
    (thread.status !== "idle" && thread.status !== "error") ||
    activity.activeBackgroundAgentCount +
      activity.activeBackgroundCommandCount +
      activity.activeWorkflowCount >
      0
  );
}

/** The threads a merge resolves: the PR's mention threads, older than the merge. */
export function threadsForMerge(
  threads: readonly ThreadSummary[],
  mentionThreadIds: ReadonlySet<string>,
  merge: MergedPr,
): ThreadSummary[] {
  return threads.filter(
    (thread) =>
      mentionThreadIds.has(thread.id) &&
      thread.deletedAt === null &&
      thread.createdAt <= merge.mergedAt,
  );
}

export class MergeResolver {
  constructor(
    private readonly sdk: Sdk,
    private readonly github: Pick<GitHubClient, "conditional">,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records PRs merged since the last poll in each repository. */
  async poll(slugs: readonly string[], signal?: AbortSignal): Promise<void> {
    for (const slug of slugs) {
      const key = `merged:${slug}`;
      const cursor = this.store.cursor(key);
      const result = await this.github.conditional<PullRequest[]>(
        `/repos/${slug}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
        cursor?.etag ?? null,
        signal,
      );
      if (result.status === 304 || !result.data) continue;
      // The first time a repository is seen, only its future merges count:
      // old threads on long-merged branches may still be in use.
      const since = cursor ? Date.parse(cursor.since) : this.now();
      let newest = since;
      for (const pull of result.data) {
        if (!pull.merged_at) continue;
        const mergedAt = Date.parse(pull.merged_at);
        newest = Math.max(newest, mergedAt);
        if (mergedAt <= since) continue;
        this.store.addMerge({ slug, number: pull.number, headRef: pull.head.ref, mergedAt });
      }
      this.store.setCursor(key, { since: new Date(newest).toISOString(), etag: result.etag });
    }
  }

  /** Archives the idle threads of pending merges in `projectsBySlug`'s repositories. */
  async resolve(projectsBySlug: ReadonlyMap<string, readonly string[]>): Promise<ResolveResult> {
    const archived: ResolveResult["archived"] = [];
    const merges = this.store.pendingMerges(this.now() - PENDING_MS);
    if (merges.length === 0) return { archived };
    const threadsByProject = new Map<string, ThreadSummary[]>();
    const threadsOf = async (projectId: string) => {
      let threads = threadsByProject.get(projectId);
      if (!threads) {
        threads = await listProjectThreads(this.sdk, projectId, [false]);
        threadsByProject.set(projectId, threads);
      }
      return threads;
    };

    for (const merge of merges) {
      const pr = `${merge.slug}#${merge.number}`;
      const mentionThreadIds = new Set(this.store.mentionThreads(merge.slug, merge.number));
      const candidates = new Map<string, ThreadSummary>();
      for (const projectId of projectsBySlug.get(merge.slug) ?? []) {
        for (const thread of threadsForMerge(await threadsOf(projectId), mentionThreadIds, merge)) {
          candidates.set(thread.id, thread);
        }
      }

      let waiting = false;
      for (const thread of candidates.values()) {
        if (thread.archivedAt !== null || thread.pinnedAt !== null) continue;
        if (this.store.wasResolved(thread.id)) continue;
        if (isBusy(thread)) {
          waiting = true;
          continue;
        }
        await this.sdk.threads.archive({ threadId: thread.id });
        this.store.markResolved(thread.id, pr);
        archived.push({ threadId: thread.id, pr });
      }
      if (!waiting) this.store.finishMerge(merge.slug, merge.number);
    }
    return { archived };
  }
}
