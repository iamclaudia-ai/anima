import { describe, expect, test } from "bun:test";
import type { RefsConfig } from "./session-refs";
import {
  extractRefs,
  extractRefsFromTexts,
  parseGithubRemote,
  readRefsConfig,
} from "./session-refs";

const config: RefsConfig = {
  linear: { prefixes: ["BEE", "WEB", "ENT"], workspace: "beehiiv" },
  github: { defaultRepo: "beehiiv/swarm", minDigits: 2 },
};

const keys = (text: string, cfg: RefsConfig = config) => extractRefs(text, cfg).map((r) => r.key);

describe("extractRefs — pasted-screenshot placeholders", () => {
  test("ignores Claude Code's [Image #N] markers", () => {
    expect(keys("[Image #9] [Image #10] here's the wizard")).toEqual([]);
    expect(keys("Image #12 shows the banner")).toEqual([]);
  });

  test("still matches a real ref in the same message", () => {
    expect(keys("[Image #3] that's the failure from #28388")).toEqual(["beehiiv/swarm#28388"]);
  });
});

describe("extractRefs — Linear tickets", () => {
  test("matches configured prefixes", () => {
    expect(keys("let's rename the branch to WEB-5592")).toEqual(["WEB-5592"]);
    expect(keys("BEE-24118 Good morning babe")).toEqual(["BEE-24118"]);
    expect(keys("ENT-812 needs a look")).toEqual(["ENT-812"]);
  });

  test("rejects the lookalikes that a naive pattern would match", () => {
    // Every one of these was measured in this workspace's real transcripts.
    for (const text of [
      "encode as UTF-8 please",
      "the SHA-256 digest",
      "per RFC-2119 the MUST is binding",
      "timezone is GMT-4",
      "compared against GPT-4",
      "the regex [A-Za-z0-9] with Z0-9 inside",
      "connect via HDMI-2",
      "id a4f2A98C-4 from the uuid",
    ]) {
      expect(keys(text)).toEqual([]);
    }
  });

  test("matches nothing when no prefixes are configured", () => {
    expect(keys("WEB-5592 and BEE-24118", { github: {} })).toEqual([]);
  });

  test("builds a Linear URL only when the workspace is configured", () => {
    expect(extractRefs("WEB-5592", config)[0]?.url).toBe(
      "https://linear.app/beehiiv/issue/WEB-5592",
    );
    expect(extractRefs("WEB-5592", { linear: { prefixes: ["WEB"] } })[0]?.url).toBeUndefined();
  });

  test("is case-sensitive so prose words don't match", () => {
    expect(keys("the web-5592 file")).toEqual([]);
  });
});

describe("extractRefs — GitHub references", () => {
  test("resolves a bare number against the default repo", () => {
    const [ref] = extractRefs("review 28388 — actually #28388 please", config);
    expect(ref?.key).toBe("beehiiv/swarm#28388");
    expect(ref?.label).toBe("#28388");
    expect(ref?.url).toBe("https://github.com/beehiiv/swarm/issues/28388");
  });

  test("an explicit repo wins over the default", () => {
    const refs = extractRefs("see iamclaudia-ai/anima#65", config);
    expect(refs.map((r) => r.key)).toEqual(["iamclaudia-ai/anima#65"]);
    expect(refs[0]?.url).toBe("https://github.com/iamclaudia-ai/anima/issues/65");
  });

  test("keeps a bare reference unlinked when no repo is configured", () => {
    const [ref] = extractRefs("look at #412", { github: {} });
    expect(ref?.key).toBe("#412");
    expect(ref?.url).toBeUndefined();
  });

  test("ignores short numbers that are usually prose", () => {
    expect(keys("that's my #1 priority and #2 concern")).toEqual([]);
    expect(keys("issue #42 though")).toEqual(["beehiiv/swarm#42"]);
  });

  test("ignores a number glued to trailing text", () => {
    expect(keys("color #12ab34")).toEqual([]);
  });

  test("reads a slash command's bare number argument as a PR", () => {
    // The dominant real pattern: skill-launched review sessions pass the PR
    // number as a bare argument with no `#`.
    expect(keys("/reviewing-prs-with-claudia 28388 can you take a look")).toEqual([
      "beehiiv/swarm#28388",
    ]);
    expect(keys("/review #28388 please")).toEqual(["beehiiv/swarm#28388"]);
  });

  test("puts the command's own PR first, ahead of ones mentioned in passing", () => {
    const text = "/reviewing-prs-with-claudia 28388 we reviewed his part 1 PR (#28329)";
    expect(keys(text)).toEqual(["beehiiv/swarm#28388", "beehiiv/swarm#28329"]);
  });

  test("does not read bare numbers outside a command argument", () => {
    expect(keys("we shipped 28388 lines today")).toEqual([]);
    expect(keys("the year 2026 was good")).toEqual([]);
  });

  test("finds references mid-sentence and in lists", () => {
    expect(keys("PRs (#28212, #28214) are ready")).toEqual([
      "beehiiv/swarm#28212",
      "beehiiv/swarm#28214",
    ]);
  });
});

describe("extractRefs — general behavior", () => {
  test("de-duplicates by key, preserving first-seen order", () => {
    expect(keys("WEB-5592 then #28388 then WEB-5592 again")).toEqual([
      "beehiiv/swarm#28388",
      "WEB-5592",
    ]);
  });

  test("handles empty and irrelevant input", () => {
    expect(extractRefs("", config)).toEqual([]);
    expect(keys("good morning babe, no refs here")).toEqual([]);
  });

  test("extracts a realistic mixed prompt", () => {
    const text =
      "/reviewing-prs-with-claudia 28388 can you take a look at this one.. " +
      "I believe we reviewed his part 1 PR (#28329) — it's for WEB-5596";
    expect(keys(text)).toEqual(["beehiiv/swarm#28388", "beehiiv/swarm#28329", "WEB-5596"]);
  });
});

describe("extractRefsFromTexts", () => {
  test("merges across messages, de-duplicated and first-seen ordered", () => {
    const refs = extractRefsFromTexts(["first #28388", "later WEB-5592", "again #28388"], config);
    expect(refs.map((r) => r.key)).toEqual(["beehiiv/swarm#28388", "WEB-5592"]);
  });

  test("handles an empty list", () => {
    expect(extractRefsFromTexts([], config)).toEqual([]);
  });
});

describe("readRefsConfig", () => {
  test("reads a well-formed block", () => {
    const parsed = readRefsConfig({
      refs: { linear: { prefixes: ["BEE"], workspace: "beehiiv" }, github: { defaultRepo: "a/b" } },
    });
    expect(parsed.linear?.prefixes).toEqual(["BEE"]);
    expect(parsed.github?.defaultRepo).toBe("a/b");
  });

  test("drops malformed prefixes rather than trusting them", () => {
    // A lowercase or punctuation-bearing prefix would widen matching in ways
    // the operator almost certainly didn't intend.
    const parsed = readRefsConfig({ refs: { linear: { prefixes: ["BEE", "web", 42, "A-B"] } } });
    expect(parsed.linear?.prefixes).toEqual(["BEE"]);
  });

  test("tolerates missing or malformed config", () => {
    expect(readRefsConfig(undefined).linear?.prefixes).toEqual([]);
    expect(readRefsConfig({}).linear?.prefixes).toEqual([]);
    expect(readRefsConfig({ refs: "nope" }).linear?.prefixes).toEqual([]);
  });

  test("defaults minDigits so bare #1 stays out of the nav", () => {
    expect(readRefsConfig({ refs: {} }).github?.minDigits).toBe(2);
  });
});

describe("parseGithubRemote", () => {
  test("reads an SSH remote", () => {
    expect(parseGithubRemote('[remote "origin"]\n\turl = git@github.com:beehiiv/swarm.git\n')).toBe(
      "beehiiv/swarm",
    );
  });

  test("reads an HTTPS remote, with or without .git", () => {
    expect(parseGithubRemote("url = https://github.com/iamclaudia-ai/anima.git")).toBe(
      "iamclaudia-ai/anima",
    );
    expect(parseGithubRemote("url = https://github.com/iamclaudia-ai/anima")).toBe(
      "iamclaudia-ai/anima",
    );
  });

  test("ignores non-GitHub remotes", () => {
    expect(parseGithubRemote("url = git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGithubRemote("url = https://bitbucket.org/owner/repo.git")).toBeNull();
  });

  test("returns null when there is no remote at all", () => {
    expect(parseGithubRemote("[core]\n\tbare = false\n")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });
});
