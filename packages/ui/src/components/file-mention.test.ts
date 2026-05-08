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

  it("treats space as part of the query (multi-token search)", () => {
    // `@foo bar` with cursor at end — space is a filter chunker, not a terminator.
    expect(findActiveMention("@foo bar", 8)).toEqual({
      triggerPos: 0,
      query: "foo bar",
      cursorPos: 8,
    });
  });

  it("stops scanning at a newline (mentions can't span lines)", () => {
    expect(findActiveMention("@foo\nbar", 8)).toBeNull();
  });

  it("skips past an invalid @ to find an earlier valid one", () => {
    // The `@` in `me@host` is invalid; scanning continues back to find `@valid`.
    const result = findActiveMention("text @valid me@host", 19);
    expect(result).toEqual({ triggerPos: 5, query: "valid me@host", cursorPos: 19 });
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

  it("closes a markdown code span when the @ was preceded by a backtick", () => {
    // User typed `` look at `@inp `` and selected `packages/ui/src/InputArea.tsx`.
    // We should auto-close the backtick so the rendered span is balanced.
    const result = applyMentionSelection(
      "look at `@inp",
      { triggerPos: 9, query: "inp", cursorPos: 13 },
      "packages/ui/src/InputArea.tsx",
    );
    expect(result.input).toBe("look at `@packages/ui/src/InputArea.tsx` ");
    expect(result.cursorPos).toBe("look at `@packages/ui/src/InputArea.tsx` ".length);
  });

  it("does not add a closing backtick when the @ wasn't in a code span", () => {
    const result = applyMentionSelection(
      "see @inp here",
      { triggerPos: 4, query: "inp", cursorPos: 8 },
      "InputArea.tsx",
    );
    // Plain space, no backtick injected.
    expect(result.input).toBe("see @InputArea.tsx  here");
  });
});
