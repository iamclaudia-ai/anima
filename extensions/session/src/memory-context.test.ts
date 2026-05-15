import { describe, expect, test } from "bun:test";
import { formatMemoryContext, truncatePreservingSurrogates } from "./memory-context";

/**
 * Walk a string and return the index of any unpaired UTF-16 surrogate.
 * A high surrogate (0xD800–0xDBFF) without a following low surrogate
 * (0xDC00–0xDFFF), or a lone low surrogate, is malformed and will be
 * rejected by strict JSON parsers like the Anthropic API's.
 */
function findUnpairedSurrogate(str: string): number {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return i;
      i += 1; // consume the low surrogate
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return i; // lone low surrogate
    }
  }
  return -1;
}

describe("truncatePreservingSurrogates", () => {
  test("returns the string unchanged when shorter than max", () => {
    expect(truncatePreservingSurrogates("hello", 500)).toBe("hello");
  });

  test("returns the string unchanged when exactly max length", () => {
    const s = "x".repeat(500);
    expect(truncatePreservingSurrogates(s, 500)).toBe(s);
  });

  test("truncates plain ASCII at the exact boundary", () => {
    const s = "a".repeat(600);
    const out = truncatePreservingSurrogates(s, 500);
    expect(out).toBe("a".repeat(500) + "...");
  });

  test("does not split a surrogate pair at the boundary", () => {
    // 499 chars of padding + the 📚 emoji (2 code units at 499/500) + filler.
    // A naive .slice(0, 500) would keep the high surrogate and drop the low,
    // leaving a malformed string.
    const padding = "a".repeat(499);
    const tail = "b".repeat(50);
    const input = `${padding}📚${tail}`;

    // Sanity check: the input itself has the emoji exactly at offset 499–500.
    expect(input.charCodeAt(499)).toBeGreaterThanOrEqual(0xd800);
    expect(input.charCodeAt(499)).toBeLessThanOrEqual(0xdbff);

    const out = truncatePreservingSurrogates(input, 500);

    // No unpaired surrogates in the output.
    expect(findUnpairedSurrogate(out)).toBe(-1);
    // The emoji was dropped (not kept half-formed), so the boundary is
    // 499 chars of "a" plus the ellipsis.
    expect(out).toBe(`${"a".repeat(499)}...`);
  });

  test("keeps the surrogate pair intact when it ends one code unit before the boundary", () => {
    // emoji at offset 498/499 — fully inside the slice. Should be kept whole.
    const input = `${"a".repeat(498)}📚${"b".repeat(50)}`;
    const out = truncatePreservingSurrogates(input, 500);
    expect(findUnpairedSurrogate(out)).toBe(-1);
    // Output contains the full emoji and stops there (no characters of "b").
    expect(out.startsWith(`${"a".repeat(498)}📚`)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
  });

  test("survives JSON round-trip after truncating at an emoji boundary", () => {
    // This is the symptom we actually shipped to Anthropic: JSON.stringify of
    // a malformed string serializes a lone \uD8XX, which strict parsers reject.
    const input = `${"x".repeat(499)}💙${"y".repeat(50)}`;
    const out = truncatePreservingSurrogates(input, 500);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });
});

describe("formatMemoryContext", () => {
  test("returns null when there is nothing to inject", () => {
    expect(formatMemoryContext({ recentMessages: [], recentSummaries: [] })).toBeNull();
  });

  test("output contains no unpaired surrogates even when a message lands an emoji on the slice boundary", () => {
    // Reproduces the production bug: a message whose 500th code unit (offset 499)
    // is the high surrogate of an astral-plane character. Pre-fix, the output
    // contained a lone \uD8XX and Anthropic returned 400.
    const padding = "a".repeat(499);
    const tail = "b".repeat(100);
    const content = `${padding}📚${tail}`;

    const out = formatMemoryContext({
      recentMessages: [{ role: "assistant", content, timestamp: "2026-05-15T23:13:17.000Z" }],
      recentSummaries: [],
    });

    expect(out).not.toBeNull();
    expect(findUnpairedSurrogate(out as string)).toBe(-1);
    // And — equivalently — the body survives a strict JSON round-trip.
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  test("includes both recent messages and summaries", () => {
    const out = formatMemoryContext({
      recentMessages: [{ role: "user", content: "hi", timestamp: "2026-05-15T23:00:00.000Z" }],
      recentSummaries: [
        {
          summary: "Earlier session about widgets.",
          firstMessageAt: "2026-05-14T10:00:00.000Z",
          lastMessageAt: "2026-05-14T11:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("<claudia_memory_context>");
    expect(out).toContain("Michael: hi");
    expect(out).toContain("Earlier session about widgets.");
    expect(out).toContain("</claudia_memory_context>");
  });
});
