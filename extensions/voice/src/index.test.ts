import { describe, expect, it } from "bun:test";
import { cleanForSpeech } from "./index";

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
});
