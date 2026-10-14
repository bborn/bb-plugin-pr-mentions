import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../lib/github.js";
import { MergeResolver } from "../lib/merged.js";
import { MIGRATIONS, Store } from "../lib/store.js";

const SLUG = "acme/app";
const MERGED = Date.parse("2026-10-14T12:00:00Z");

function makeStore(): Store {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return new Store(db);
}

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "proj_1",
    environmentBranchName: "feature/x",
    createdAt: MERGED - 60_000,
    updatedAt: MERGED - 60_000,
    archivedAt: null as number | null,
    deletedAt: null,
    pinnedAt: null,
    status: "idle",
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    ...overrides,
  };
}

let mentionId = 0;
/** A /bb mention on PR `number` that was sent to `threadId`. */
function mentioned(store: Store, number: number, threadId: string, status: "delivered" | "spawned" | "refused" = "delivered") {
  mentionId += 1;
  store.record(
    {
      key: `issue-comment:${mentionId}`,
      kind: "issue-comment",
      commentId: mentionId,
      slug: SLUG,
      number,
      url: `https://github.com/${SLUG}/pull/${number}#issuecomment-${mentionId}`,
      author: "me",
      instruction: "fix it",
      createdAt: "2026-10-14T11:00:00Z",
    },
    status,
    status === "refused" ? null : threadId,
    null,
  );
}

function pull(number: number, ref: string, mergedAt: string | null, repo = SLUG) {
  return {
    number,
    merged_at: mergedAt,
    head: { ref, repo: { full_name: repo } },
    base: { ref: "main", repo: { full_name: SLUG } },
  };
}

function setup(threads: ReturnType<typeof thread>[], pulls: unknown[]) {
  const store = makeStore();
  const archived: string[] = [];
  const sdk = {
    threads: {
      list: async (args: { archived: boolean; offset: number }) =>
        args.offset > 0 ? [] : threads.filter((t) => (t.archivedAt !== null) === args.archived),
      archive: async ({ threadId }: { threadId: string }) => {
        archived.push(threadId);
        threads.find((t) => t.id === threadId)!.archivedAt = Date.now();
        return { ok: true, archivedThreadIds: [threadId] };
      },
    },
  };
  let calls = 0;
  const github = {
    conditional: async () => {
      calls += 1;
      return { status: 200 as const, etag: `"${calls}"`, data: pulls };
    },
  } as unknown as GitHubClient;
  let now = MERGED - 3600_000;
  const resolver = new MergeResolver(sdk as never, github, store, () => now);
  const projects = new Map([[SLUG, ["proj_1"]]]);
  return {
    store,
    archived,
    projects,
    resolver,
    /** First poll sets the baseline before the merge; later polls see it. */
    async pollAfterMerge() {
      await resolver.poll([SLUG]);
      now = MERGED + 60_000;
      await resolver.poll([SLUG]);
      return resolver.resolve(projects);
    },
  };
}

describe("MergeResolver", () => {
  let merged: string;
  beforeEach(() => {
    merged = new Date(MERGED).toISOString();
  });

  it("archives only the idle threads the PR's mentions went to, once", async () => {
    const threads = [
      thread("thr_mentioned"),
      thread("thr_same_branch_untagged"),
      thread("thr_other_pr"),
      thread("thr_newer", { createdAt: MERGED + 1 }),
      thread("thr_pinned", { pinnedAt: 1 }),
    ];
    const t = setup(threads, [pull(7, "feature/x", merged), pull(8, "feature/y", null)]);
    mentioned(t.store, 7, "thr_mentioned");
    mentioned(t.store, 8, "thr_other_pr");
    mentioned(t.store, 7, "thr_newer", "spawned");
    mentioned(t.store, 7, "thr_pinned");
    const result = await t.pollAfterMerge();
    expect(result.archived).toEqual([{ threadId: "thr_mentioned", pr: `${SLUG}#7` }]);

    // Reopened by the user: never archived again.
    threads[0]!.archivedAt = null;
    t.store.addMerge({ slug: SLUG, number: 9, headRef: "feature/x", mergedAt: MERGED });
    expect((await t.resolver.resolve(t.projects)).archived).toEqual([]);
    expect(t.archived).toEqual(["thr_mentioned"]);
  });

  it("ignores merges from before it started watching", async () => {
    const t = setup([thread("thr_old")], [pull(7, "feature/x", "2026-10-01T00:00:00Z")]);
    mentioned(t.store, 7, "thr_old");
    expect((await t.pollAfterMerge()).archived).toEqual([]);
  });

  it("waits for busy threads, then archives them", async () => {
    const threads = [thread("thr_busy", { status: "active" })];
    const t = setup(threads, [pull(7, "feature/x", merged)]);
    mentioned(t.store, 7, "thr_busy");
    expect((await t.pollAfterMerge()).archived).toEqual([]);
    threads[0]!.status = "idle";
    expect((await t.resolver.resolve(t.projects)).archived).toEqual([
      { threadId: "thr_busy", pr: `${SLUG}#7` },
    ]);
  });

  it("ignores refused mentions", async () => {
    const t = setup([thread("thr_1")], [pull(7, "feature/x", merged)]);
    mentioned(t.store, 7, "thr_1", "refused");
    expect((await t.pollAfterMerge()).archived).toEqual([]);
  });
});
