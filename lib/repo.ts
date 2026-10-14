// GitHub repository identity, as "owner/name" in lowercase.

/**
 * Returns "owner/name" for a github.com remote URL in any of its usual forms
 * (scp-style ssh, ssh://, https://, with or without .git), or null for
 * anything that is not a github.com repository.
 */
export function githubSlugFromRemote(
  remoteUrl: string | null | undefined,
): string | null {
  if (!remoteUrl) return null;
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/|https?:\/\/(?:[^@/]+@)?github\.com\/|git:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(
      remoteUrl.trim(),
    );
  if (!match) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/** Parses "owner/name" or a github.com URL into a slug; null when invalid. */
export function normalizeSlug(value: string): string | null {
  const trimmed = value.trim();
  if (/^[\w.-]+\/[\w.-]+$/u.test(trimmed)) return trimmed.toLowerCase();
  return githubSlugFromRemote(trimmed);
}

export interface PullRef {
  slug: string;
  number: number;
}

/** Parses "owner/name#12" or a github.com issue/pull URL. */
export function parsePullRef(value: string): PullRef | null {
  const trimmed = value.trim();
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/u.exec(trimmed);
  if (short) return { slug: short[1]!.toLowerCase(), number: Number(short[2]) };
  const url =
    /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/iu.exec(
      trimmed,
    );
  if (url) return { slug: url[1]!.toLowerCase(), number: Number(url[2]) };
  return null;
}
