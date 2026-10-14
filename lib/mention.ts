// Finding the trigger word in a GitHub comment body.
//
// A trigger only counts in prose the user wrote: not inside fenced code, not
// in inline code, and not in a quoted reply ("> /bb fix this" is someone
// quoting an earlier request, and answering it again would loop).

/**
 * Hidden marker the agent ends its GitHub replies with. A comment carrying it
 * never counts, so a reply that happens to contain the trigger cannot summon
 * BB again.
 */
export const REPLY_MARKER = "<!-- bb-pr-mentions -->";

export interface ParsedMention {
  /** The comment body with the trigger token removed, trimmed. */
  instruction: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Returns the parsed request when `body` addresses `trigger` (case-insensitive),
 * or null when it does not.
 */
export function parseMention(
  body: string | null | undefined,
  trigger: string,
): ParsedMention | null {
  const word = trigger.trim();
  if (!body || word === "" || body.includes(REPLY_MARKER)) return null;
  // Preceded by start or whitespace, so "https://x.com/bb" and "foo/bb" do not
  // match; followed by a non-word character, so "@bbot" does not match "@bb".
  const pattern = new RegExp(
    `(^|\\s)${escapeRegExp(word)}(?![\\w-])[:,]?`,
    "giu",
  );

  let inFence = false;
  let found = false;
  const kept: string[] = [];
  for (const line of body.replace(/\r\n?/gu, "\n").split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence || /^\s*>/u.test(line)) {
      kept.push(line);
      continue;
    }
    // Blank out inline code spans before testing, but keep them in the output.
    const prose = line.replace(/`[^`]*`/gu, (span) => " ".repeat(span.length));
    pattern.lastIndex = 0;
    if (!pattern.test(prose)) {
      kept.push(line);
      continue;
    }
    found = true;
    let result = "";
    let cursor = 0;
    pattern.lastIndex = 0;
    for (const match of prose.matchAll(pattern)) {
      const start = match.index + match[1]!.length;
      result += line.slice(cursor, start);
      cursor = match.index + match[0].length;
      // Drop the space after the trigger when one already precedes it.
      if (/\s$/u.test(result) && /^\s/u.test(line.slice(cursor))) cursor += 1;
    }
    result += line.slice(cursor);
    kept.push(result.replace(/^\s+/u, ""));
  }
  if (!found) return null;
  return { instruction: kept.join("\n").trim() };
}
