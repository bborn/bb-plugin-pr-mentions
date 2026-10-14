export type MentionKind = "issue-comment" | "review-comment" | "review";

/** One GitHub comment that addressed the trigger, normalized across kinds. */
export interface Mention {
  /** Dedupe key, e.g. "issue-comment:123". */
  key: string;
  kind: MentionKind;
  commentId: number;
  slug: string;
  number: number;
  url: string;
  author: string;
  instruction: string;
  createdAt: string;
  /** Set for inline review comments. */
  code?: {
    path: string;
    line: number | null;
    diffHunk: string;
  };
}

export type MentionStatus =
  | "pending"
  | "delivered"
  | "spawned"
  | "unrouted"
  /** Routable, but not allowed: a PR or issue opened by someone else, or a public repository. */
  | "refused"
  | "error";
