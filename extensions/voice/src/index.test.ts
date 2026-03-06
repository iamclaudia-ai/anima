import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanForSpeech, StreamingSpeechFilter } from "./index";
import { SentenceChunker } from "./sentence-chunker";

describe("cleanForSpeech", () => {
  it("removes bullet list items", () => {
    const input = [
      "Here is what I found:",
      "- first bullet",
      "* second bullet",
      "• third bullet",
      "This sentence should stay.",
    ].join("\n");

    expect(cleanForSpeech(input)).toBe("Here is what I found: This sentence should stay.");
  });

  it("removes numbered list items", () => {
    const input = [
      "Plan:",
      "1. first",
      "2) second",
      "3 . spaced separator",
      "4\\. escaped dot in markdown",
      "Done.",
    ].join("\n");

    expect(cleanForSpeech(input)).toBe("Plan: Done.");
  });

  it("removes bold numbered list items", () => {
    const input = ["Summary:", "**1. first**", "  **2) second**", "Done."].join("\n");
    expect(cleanForSpeech(input)).toBe("Summary: Done.");
  });

  it("removes fenced code blocks with indented fences", () => {
    const input = [
      "I checked the implementation:",
      "   ```typescript",
      "   const x = 1;",
      "   console.log(x);",
      "   ```",
      "All good now.",
    ].join("\n");
    expect(cleanForSpeech(input)).toBe("I checked the implementation: All good now.");
  });

  it("filters fenced code blocks across streaming chunks", () => {
    const filter = new StreamingSpeechFilter();
    const chunker = new SentenceChunker();

    const input = [
      "Here is the plan.",
      "```typescript",
      "const x = 1;",
      "console.log(x);",
      "```",
      "This should be spoken.",
    ].join("\n");

    const chunks = [
      input.slice(0, 18),
      input.slice(18, 37),
      input.slice(37, 55),
      input.slice(55, 80),
      input.slice(80),
    ];

    const spoken: string[] = [];
    for (const chunk of chunks) {
      const filtered = filter.feed(chunk);
      if (!filtered) continue;
      for (const sentence of chunker.feed(filtered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const trailingFiltered = filter.flush();
    if (trailingFiltered) {
      for (const sentence of chunker.feed(trailingFiltered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const remaining = chunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) spoken.push(cleaned);
    }

    expect(spoken.join(" ")).toBe("Here is the plan. This should be spoken.");
  });

  it("matches transcript expected output", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const transcript = readFileSync(join(repoRoot, "tmp", "transcript.md"), "utf8");
    const expected = readFileSync(join(repoRoot, "tmp", "transcript-result.md"), "utf8");

    expect(cleanForSpeech(transcript)).toBe(cleanForSpeech(expected));
  });

  it("matches transcript expected output through streaming simulation", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const transcript = readFileSync(join(repoRoot, "tmp", "transcript.md"), "utf8");
    const expected = readFileSync(join(repoRoot, "tmp", "transcript-result.md"), "utf8");

    const filter = new StreamingSpeechFilter();
    const chunker = new SentenceChunker();
    const spoken: string[] = [];

    const chunkSize = 73;
    for (let i = 0; i < transcript.length; i += chunkSize) {
      const filtered = filter.feed(transcript.slice(i, i + chunkSize));
      if (!filtered) continue;
      for (const sentence of chunker.feed(filtered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const trailingFiltered = filter.flush();
    if (trailingFiltered) {
      for (const sentence of chunker.feed(trailingFiltered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const remaining = chunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) spoken.push(cleaned);
    }

    expect(spoken.join(" ")).toBe(cleanForSpeech(expected));
  });
});
