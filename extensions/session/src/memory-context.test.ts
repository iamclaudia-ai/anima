import { describe, expect, test } from "bun:test";
import { formatMemoryContext } from "./memory-context";

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

// truncatePreservingSurrogates tests moved to packages/shared/src/text.test.ts (#34)

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
