import { describe, expect, it } from "bun:test";
import { applyMentionSelection, findActiveMention } from "./file-mention";

describe("findActiveMention", () => {
  it("triggers when @ is at position 0", () => {
    expect(findActiveMention("@foo", 4)).toEqual({ triggerPos: 0, query: "foo", cursorPos: 4 });
  });

  it("triggers when @ is preceded by whitespace", () => {
    const result = findActiveMention("hello @foo", 10);
    expect(result).toEqual({ triggerPos: 6, query: "foo", cursorPos: 10 });
  });

  it("triggers when @ is preceded by a backtick (Michael's special case)", () => {
    const result = findActiveMention("look at `@src/index.ts", 22);
    expect(result).toEqual({ triggerPos: 9, query: "src/index.ts", cursorPos: 22 });
  });

  it("does NOT trigger inside an email (alpha char before @)", () => {
    expect(findActiveMention("ping me@host.com", 16)).toBeNull();
  });

  it("does NOT trigger when the @ is mid-word (path/to@file)", () => {
    expect(findActiveMention("path/to@file", 12)).toBeNull();
  });

  it("returns null when the cursor is past whitespace following the @", () => {
    // `@foo bar` with cursor after `bar` — the space ended the candidate
    expect(findActiveMention("@foo bar", 8)).toBeNull();
  });

  it("returns the query truncated at the cursor (mid-typing)", () => {
    // user typed `hello @sr` but cursor is between `s` and `r`
    const result = findActiveMention("hello @sr", 8);
    expect(result).toEqual({ triggerPos: 6, query: "s", cursorPos: 8 });
  });

  it("handles an empty query just after @", () => {
    expect(findActiveMention("@", 1)).toEqual({ triggerPos: 0, query: "", cursorPos: 1 });
  });

  it("returns null when there is no @ at all", () => {
    expect(findActiveMention("hello world", 11)).toBeNull();
  });
});

describe("applyMentionSelection", () => {
  it("replaces just the mention segment, preserving text before and after", () => {
    const result = applyMentionSelection(
      "tell me about @src and the rest",
      { triggerPos: 14, query: "src", cursorPos: 17 },
      "packages/ui/src/index.ts",
    );
    expect(result.input).toBe("tell me about @packages/ui/src/index.ts  and the rest");
    // Cursor sits right after the inserted path + trailing space
    expect(result.cursorPos).toBe("tell me about @packages/ui/src/index.ts ".length);
  });

  it("works at position 0 with no surrounding text", () => {
    const result = applyMentionSelection(
      "@fo",
      { triggerPos: 0, query: "fo", cursorPos: 3 },
      "foo.ts",
    );
    expect(result.input).toBe("@foo.ts ");
    expect(result.cursorPos).toBe("@foo.ts ".length);
  });
});
