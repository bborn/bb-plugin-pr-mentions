# PR Mentions

Write `/bb` in a GitHub pull request comment and the request goes to the BB
thread working on that PR. If no thread is on it, BB starts one.

```
/bb rename this to fetchAll and update the callers
```

Works in PR conversation comments, inline review comments (the agent gets the
file, line, and diff hunk), review summaries, and plain issues (a new thread
picks the issue up). BB reacts with 👀 on the comment when it picks it up (😕
when it can't or won't), and the agent replies on the PR when it is done. The
reply is posted from your account, so it ends with a small signature:

> Merged main in and fixed the conflicts. The tests pass locally.
>
> <sub>🤖 Written by BB in [thr_k2v9x4m7qa](#)</sub>

The thread id links to that thread in BB, so you can jump back into it.

## How it finds the thread

1. The thread this PR was sent to before, or one you linked with
   `bb pr-mentions link`.
2. The most recently updated thread whose environment is on the PR's head
   branch, in any project whose git remote is that repository.
3. Otherwise a new thread in that project, in a fresh git worktree based on
   the PR branch. Its first step is `gh pr checkout`.

Archived threads are unarchived when a new request arrives for them.

## Several repositories

Every BB project whose git remote is a private github.com repository is
watched. Adding a project adds its repository; nothing else to configure.
Public repositories are never watched (see below), and a repository with no BB
project is ignored. `bb pr-mentions status` lists both.

## How it reaches GitHub

It polls; no webhook, no public port. Each repository costs two requests per
interval (issue comments, review comments) plus one for your event feed
(review summaries). These are conditional requests, and GitHub does not count
an unchanged (304) answer against the rate limit. The default interval is 30
seconds.

Authentication is `gh auth token` on the bb server machine, or the
`githubToken` setting.

## Security

An agent acting on a request works with your permissions on your machine, so
the plugin limits what can reach it:

- **Private repositories only.** On a public one anyone can open issues and
  PRs and write comments. Visibility is checked hourly, and again before each
  request is routed.
- **Only your comments.** Comments by you (the GitHub account the token belongs
  to) and by logins in **Also accept comments from** count. Anyone listed there
  can make an agent run commands on your machine.
- **Edited comments never count.** Repository admins can edit anyone's comment
  without changing its author, so a comment changed after it was posted is
  ignored. Post a new comment instead of editing one.
- **Only your PRs and issues.** By default BB refuses (😕) PRs and issues opened
  by anyone else, and PRs from forks: the agent would read, and may run, their
  code. **Act on PRs and issues opened by others** turns this off.
- **GitHub text is information, not instructions.** The agent is told that only
  your comment is a request, and that anything else it reads on GitHub (titles,
  descriptions, other comments, code) is not.
- **No loops.** The agent's replies end with a hidden
  `<!-- bb-pr-mentions -->` marker, and comments carrying it are ignored.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Trigger | `/bb` | Avoid `@bb`: that is a real GitHub user, who would be notified every time |
| Also accept comments from | empty | Comma-separated GitHub logins; give this only to people you'd give shell access |
| Act on PRs and issues opened by others | off | Includes PRs from forks |
| Poll interval | 30 s | 15–3600 |
| Start a new thread when no thread is on the PR | on | |
| New threads run in | worktree | or the project's default environment |
| Ask the agent to reply on GitHub when done | on | |
| React with 👀 | on | 😕 when nothing could take it |
| BB address for thread links | auto | BB's app URL, else the Tailscale Serve address in front of BB, else the thread id without a link |
| GitHub token | `gh auth token` | Other BB plugins can read a token stored here; prefer `gh` |

## Commands

```
bb pr-mentions status      # watched and skipped repos, last poll, recent mentions and where they went
bb pr-mentions poll        # poll now
bb pr-mentions reply [comment-url] --body-stdin   # what agents use to answer, signed and linked
bb pr-mentions retry [comment-url]                # handle failed mentions (or one) again
bb pr-mentions link <owner/repo#N | PR URL> [thread-id]
bb pr-mentions unlink <owner/repo#N | PR URL>
bb pr-mentions links
```

## Develop

```
npm install
npm test
npx tsc
bb plugin install .
```
