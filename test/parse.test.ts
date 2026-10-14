import { describe, expect, it } from "vitest";
import { parseMention } from "../lib/mention.js";
import { githubSlugFromRemote, normalizeSlug, parsePullRef } from "../lib/repo.js";

describe("parseMention", () => {
  it("finds the trigger at the start and strips it", () => {
    expect(parseMention("/bb fix the typo", "/bb")).toEqual({ instruction: "fix the typo" });
    expect(parseMention("/BB: please rename this", "/bb")).toEqual({
      instruction: "please rename this",
    });
  });

  it("finds the trigger mid-sentence", () => {
    expect(parseMention("looks off, /bb can you fix it?", "/bb")?.instruction).toBe(
      "looks off, can you fix it?",
    );
  });

  it("keeps the rest of a multi-line comment", () => {
    expect(parseMention("Two things:\n/bb\n- rename x\n- drop y", "/bb")?.instruction).toBe(
      "Two things:\n\n- rename x\n- drop y",
    );
  });

  it("ignores lookalikes", () => {
    expect(parseMention("see https://example.com/bb/page", "/bb")).toBeNull();
    expect(parseMention("cc @bbot", "@bb")).toBeNull();
    expect(parseMention("/bbx do it", "/bb")).toBeNull();
    expect(parseMention("/bb-later do it", "/bb")).toBeNull();
    expect(parseMention("nothing here", "/bb")).toBeNull();
    expect(parseMention(null, "/bb")).toBeNull();
  });

  it("ignores quotes and code", () => {
    expect(parseMention("> /bb fix this\n\nDone, thanks", "/bb")).toBeNull();
    expect(parseMention("run `/bb fix` to ask", "/bb")).toBeNull();
    expect(parseMention("```\n/bb fix\n```", "/bb")).toBeNull();
  });

  it("supports an @ trigger", () => {
    expect(parseMention("@bb fix this", "@bb")?.instruction).toBe("fix this");
  });
});

describe("repo parsing", () => {
  it("reads every github remote form", () => {
    for (const remote of [
      "git@github.com:Acme/widgets.git",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets",
      "ssh://git@github.com/acme/widgets.git",
      "https://x-access-token:abc@github.com/acme/widgets.git",
    ]) {
      expect(githubSlugFromRemote(remote)).toBe("acme/widgets");
    }
    expect(githubSlugFromRemote("git@gitlab.com:a/b.git")).toBeNull();
    expect(githubSlugFromRemote(null)).toBeNull();
    expect(githubSlugFromRemote("https://github.com/get-bb/bb.js")).toBe("get-bb/bb.js");
  });

  it("parses PR references", () => {
    expect(parsePullRef("acme/app#12")).toEqual({ slug: "acme/app", number: 12 });
    expect(parsePullRef("https://github.com/Get-BB/bb/pull/4667/files")).toEqual({
      slug: "get-bb/bb",
      number: 4667,
    });
    expect(parsePullRef("4667")).toBeNull();
    expect(normalizeSlug("Get-BB/bb")).toBe("get-bb/bb");
  });
});
