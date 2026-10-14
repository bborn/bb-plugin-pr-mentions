// bb-plugin-pr-mentions — write the trigger (default "/bb") in a GitHub PR
// comment and the request lands in the BB thread working on that PR, or in a
// new thread when none is.
//
// A background service polls every private GitHub repository that a BB project
// points at (see lib/poller.ts), keeps only unedited comments by you or by
// allowedUsers, and routes each one (see lib/router.ts).
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { tailscaleServeOrigin, threadUrl } from "./lib/bb-url.js";
import { GitHubClient } from "./lib/github.js";
import { signedReply } from "./lib/message.js";
import { Poller, type PollSummary } from "./lib/poller.js";
import { parsePullRef } from "./lib/repo.js";
import { Router, projectsBySlug } from "./lib/router.js";
import { MIGRATIONS, Store } from "./lib/store.js";
import type { Mention } from "./lib/types.js";
import { RepoVisibility } from "./lib/visibility.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    trigger: {
      type: "string",
      label: "Trigger",
      description:
        'Word that summons BB in a comment, e.g. "/bb fix the typo". Avoid "@bb": that is a real GitHub user and would be notified.',
      experimental_schema: z.string().trim().min(2).max(40).regex(/^\S+$/u, "No spaces"),
      default: "/bb",
    },
    allowedUsers: {
      type: "string",
      label: "Also accept comments from",
      description:
        "Comma-separated GitHub logins. You (the signed-in GitHub user) are always accepted; nobody else is unless listed. Anyone listed can make an agent run commands on your machine, so only add people you would give shell access.",
      default: "",
    },
    actOnOthersWork: {
      type: "boolean",
      label: "Act on PRs and issues opened by others",
      description:
        "Off: BB only works on PRs and issues opened by you or the people above, and never on PRs from forks, because the agent reads and may run that code with your permissions.",
      default: false,
    },
    pollSeconds: {
      type: "number",
      label: "Poll interval (seconds)",
      experimental_schema: z.number().int().min(15).max(3600),
      default: 30,
    },
    spawnNewThreads: {
      type: "boolean",
      label: "Start a new thread when no thread is on the PR",
      default: true,
    },
    newThreadEnvironment: {
      type: "select",
      label: "New threads run in",
      description:
        "worktree: a fresh git worktree based on the PR branch, so your main checkout is never switched. project-default: whatever the project normally uses.",
      options: ["worktree", "project-default"],
      default: "worktree",
    },
    replyOnGitHub: {
      type: "boolean",
      label: "Ask the agent to reply on GitHub when done",
      default: true,
    },
    reactOnGitHub: {
      type: "boolean",
      label: "React with 👀 on comments BB picked up",
      default: true,
    },
    bbUrl: {
      type: "string",
      label: "BB address for thread links (optional)",
      description:
        "Where you open BB, e.g. https://mybox.tailnet.ts.net:8443. Replies link to their thread there. Empty: BB's configured app URL, or the Tailscale Serve address in front of BB, or no link (thread id only).",
      default: "",
    },
    githubToken: {
      type: "string",
      label: "GitHub token (optional)",
      description:
        "Leave empty to use `gh auth token` on the bb server machine (recommended: other installed BB plugins can read settings stored here). Needs repo read and comment reaction access.",
      secret: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  const github = new GitHubClient(async () => {
    const { githubToken } = await settings.get();
    return typeof githubToken === "string" ? githubToken : "";
  });
  const router = new Router(bb.sdk, github, store);
  const visibility = new RepoVisibility(github);

  let detectedBbUrl: { value: string | null; at: number } | null = null;
  async function bbUrl(): Promise<string | null> {
    const configured = (await settings.get()).bbUrl.trim();
    if (configured !== "") return configured;
    try {
      const appUrl = bb.server.experimental_appUrl;
      if (appUrl) return appUrl;
    } catch {
      // Older servers do not expose it.
    }
    if (!detectedBbUrl || Date.now() - detectedBbUrl.at > 10 * 60_000) {
      detectedBbUrl = {
        value: await tailscaleServeOrigin(bb.server.loopbackBaseUrl),
        at: Date.now(),
      };
    }
    return detectedBbUrl.value;
  }

  function allowedUsers(value: string): string[] {
    return value
      .split(/[\s,]+/u)
      .map((login) => login.replace(/^@/u, ""))
      .filter((login) => login !== "");
  }

  async function handle(mention: Mention): Promise<void> {
    const current = await settings.get();
    const projectIds = (await projectsBySlug(bb.sdk)).get(mention.slug) ?? [];
    const label = `${mention.slug}#${mention.number} ${mention.key}`;
    try {
      // Checked again here: a retried mention may predate a repo going public.
      const result =
        (await visibility.of(mention.slug)) !== "private"
          ? { status: "refused" as const, threadId: null, detail: "repository is not private" }
          : await router.route(mention, projectIds, {
              trigger: current.trigger,
              replyOnGitHub: current.replyOnGitHub,
              spawnNewThreads: current.spawnNewThreads,
              newThreadEnvironment:
                current.newThreadEnvironment === "project-default" ? "project-default" : "worktree",
              trustedAuthors: new Set(
                [await github.viewerLogin(), ...allowedUsers(current.allowedUsers)].map((login) =>
                  login.toLowerCase(),
                ),
              ),
              actOnOthersWork: current.actOnOthersWork,
            });
      store.record(mention, result.status, result.threadId, result.detail);
      bb.log.info(`${label}: ${result.status} ${result.threadId ?? ""} (${result.detail})`);
      if (current.reactOnGitHub && mention.kind !== "review") {
        await github
          .react(
            mention.slug,
            mention.kind,
            mention.commentId,
            result.status === "unrouted" || result.status === "refused" ? "confused" : "eyes",
          )
          .catch((error: Error) => bb.log.warn(`${label}: reaction failed: ${error.message}`));
      }
    } catch (error) {
      const message = (error as Error).message;
      store.record(mention, "error", null, message.slice(0, 500));
      bb.log.warn(`${label}: ${message}`);
    }
  }

  const poller = new Poller(github, store, handle);
  let inFlight: Promise<PollSummary> | null = null;
  function pollNow(signal?: AbortSignal): Promise<PollSummary> {
    inFlight ??= (async () => {
      try {
        const current = await settings.get();
        const all = [...(await projectsBySlug(bb.sdk)).keys()].sort();
        const { watched } = await visibility.partition(all, signal);
        return await poller.pollOnce(
          watched,
          { trigger: current.trigger, allowedUsers: allowedUsers(current.allowedUsers) },
          signal,
        );
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  let lastError: string | null = null;
  let lastPollAt: number | null = null;

  bb.background.service("poller", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await pollNow(signal);
          lastPollAt = Date.now();
          if (lastError) bb.log.info("polling recovered");
          lastError = null;
        } catch (error) {
          const message = (error as Error).message;
          // Log a repeating failure once, not every interval.
          if (message !== lastError && !signal.aborted) bb.log.warn(`poll failed: ${message}`);
          lastError = message;
        }
        const { pollSeconds } = await settings.get();
        // Back off on rate limiting; GitHub resets within the hour.
        const rateLimited = /GitHub (403|429)/u.test(lastError ?? "");
        await sleep((rateLimited ? Math.max(pollSeconds, 300) : pollSeconds) * 1000, signal);
      }
    },
  });

  function formatRow(row: ReturnType<Store["recent"]>[number]): string {
    const when = new Date(row.handled_at).toISOString().slice(0, 16).replace("T", " ");
    const thread = row.thread_id ? ` → ${row.thread_id}` : "";
    return `${when}  ${row.status.padEnd(9)} ${row.slug}#${row.number} @${row.author}${thread}\n    ${row.detail ?? ""}\n    ${row.url}`;
  }

  function threadIdFrom(value: string | undefined, ctxThreadId: string | undefined): string {
    const threadId = value ?? ctxThreadId;
    if (!threadId) {
      throw new PluginCliError("Which thread? Pass a thread id.", {
        code: "thread_required",
        hint: "Run it from inside the thread, or pass the id: bb pr-mentions link <pr> <thread-id>",
      });
    }
    return threadId;
  }

  function pullRef(value: string) {
    const ref = parsePullRef(value);
    if (!ref) {
      throw new PluginCliError(`Not a PR reference: ${value}`, {
        code: "bad_pr",
        hint: "Use owner/repo#123 or https://github.com/owner/repo/pull/123",
      });
    }
    return ref;
  }

  bb.cli.register(
    defineCli({
      name: "pr-mentions",
      summary: "Route GitHub PR comments that mention BB to the PR's thread",
      commands: {
        status: cliCommand({
          summary: "Show watched repositories and recent mentions",
          options: {
            limit: { type: "integer", min: 1, max: 100, default: 10, description: "Recent mentions to show (max 100)" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run({ options }) {
            const current = await settings.get();
            const repos = await projectsBySlug(bb.sdk);
            let skipped = new Map<string, string>();
            try {
              skipped = (await visibility.partition([...repos.keys()])).skipped;
            } catch (error) {
              lastError ??= (error as Error).message;
            }
            const watched = [...repos].filter(([slug]) => !skipped.has(slug));
            const recent = store.recent(options.limit);
            let viewer: string | null = null;
            try {
              viewer = await github.viewerLogin();
            } catch (error) {
              lastError ??= (error as Error).message;
            }
            const value = {
              trigger: current.trigger,
              viewer,
              pollSeconds: current.pollSeconds,
              lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
              lastError,
              repos: Object.fromEntries(watched),
              notWatched: Object.fromEntries(skipped),
              recent: recent.map(({ payload: _payload, ...row }) => row),
            };
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(value) };
            const lines = [
              `Trigger: ${current.trigger}   GitHub user: ${viewer ?? "unknown"}   every ${current.pollSeconds}s`,
              `Last poll: ${value.lastPollAt ?? "not yet"}${lastError ? `   last error: ${lastError}` : ""}`,
              "",
              `Watching ${watched.length} private repositories:`,
              ...watched.map(([slug, ids]) => `  ${slug}  (${ids.join(", ")})`),
              ...(skipped.size === 0
                ? []
                : [
                    "",
                    "Not watched:",
                    ...[...skipped].map(([slug, why]) => `  ${slug}  (${why === "public" ? "public" : "token cannot see it"})`),
                  ]),
              "",
              recent.length === 0 ? "No mentions yet." : "Recent mentions:",
              ...recent.map(formatRow),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        poll: cliCommand({
          summary: "Poll GitHub now instead of waiting for the next interval",
          async run(_input, ctx) {
            const summary = await pollNow(ctx.signal);
            lastPollAt = Date.now();
            return {
              exitCode: 0,
              stdout: `Polled ${summary.repos} repositories; handled ${summary.found} mention(s).`,
            };
          },
        }),
        retry: cliCommand({
          summary: "Handle failed mentions again, or one mention by its comment URL",
          description:
            "Without a URL, retries every mention that ended in error. With a URL (as shown in status), handles that comment again whatever happened to it, e.g. after changing a setting.",
          positionals: [{ name: "url", description: "Comment URL from bb pr-mentions status" }],
          async run({ positionals }, ctx) {
            const count = store.requeue(positionals.url);
            if (count === 0) {
              return { exitCode: 0, stdout: positionals.url ? "No mention with that URL." : "Nothing failed." };
            }
            const summary = await pollNow(ctx.signal);
            lastPollAt = Date.now();
            return { exitCode: 0, stdout: `Retried ${count}; handled ${summary.found} mention(s).` };
          },
        }),
        reply: cliCommand({
          summary: "Reply on GitHub to a mention, signed as BB with a link to this thread",
          description:
            "Posts where the mention was made (the inline review thread, or the PR/issue conversation). Without a URL, replies to the latest mention sent to the current thread.",
          positionals: [{ name: "url", description: "Comment URL of the mention" }],
          options: {
            body: {
              type: "string",
              required: true,
              stdin: true,
              description: "Reply text (Markdown). Use --body-stdin to pass it on stdin",
            },
            "dry-run": { type: "boolean", description: "Print the signed reply instead of posting it" },
          },
          async run({ positionals, options }, ctx) {
            const found = store.find(positionals.url, ctx.threadId);
            if (!found) {
              throw new PluginCliError("No mention to reply to.", {
                code: "mention_not_found",
                hint: positionals.url
                  ? "Use the comment URL exactly as bb pr-mentions status shows it."
                  : "Pass the mention's comment URL, or run this from the thread it was sent to.",
              });
            }
            const text = options.body.trim();
            if (text === "") {
              throw new PluginCliError("The reply is empty.", { code: "empty_body" });
            }
            const threadId = ctx.threadId ?? found.threadId;
            let link: string | null = null;
            if (threadId) {
              const base = await bbUrl();
              if (base) {
                const thread = await bb.sdk.threads.get({ threadId });
                link = threadUrl(base, thread.projectId, threadId);
              }
            }
            const body = signedReply(text, threadId, link);
            if (options["dry-run"]) return { exitCode: 0, stdout: body };
            const posted = await github.reply(found.mention, body);
            return { exitCode: 0, stdout: `Replied: ${posted.html_url}` };
          },
        }),
        link: cliCommand({
          summary: "Send future mentions on a PR to a thread",
          description:
            "Overrides branch matching. Without a thread id, links the thread you run it from.",
          positionals: [
            { name: "pr", description: "owner/repo#123 or a PR URL", required: true },
            { name: "thread", description: "Thread id (default: the current thread)" },
          ],
          async run({ positionals }, ctx) {
            const ref = pullRef(positionals.pr);
            const threadId = threadIdFrom(positionals.thread, ctx.threadId);
            await bb.sdk.threads.get({ threadId });
            store.setLink(ref.slug, ref.number, threadId);
            return { exitCode: 0, stdout: `${ref.slug}#${ref.number} → ${threadId}` };
          },
        }),
        unlink: cliCommand({
          summary: "Forget which thread a PR goes to",
          positionals: [{ name: "pr", description: "owner/repo#123 or a PR URL", required: true }],
          async run({ positionals }) {
            const ref = pullRef(positionals.pr);
            const removed = store.removeLink(ref.slug, ref.number);
            return {
              exitCode: 0,
              stdout: removed ? `Unlinked ${ref.slug}#${ref.number}.` : "No link for that PR.",
            };
          },
        }),
        links: cliCommand({
          summary: "List PR → thread links",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run({ options }) {
            const links = store.links().slice(0, 200);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(links) };
            return {
              exitCode: 0,
              stdout:
                links.length === 0
                  ? "No links yet."
                  : links.map((link) => `${link.pr} → ${link.thread_id}`).join("\n"),
            };
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    inFlight = null;
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
