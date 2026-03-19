import { describe, expect, it } from "bun:test";
import { mergeRequestTags } from "./requestTags";

describe("mergeRequestTags", () => {
  it("returns default tags when no explicit tags are provided", () => {
    expect(mergeRequestTags(undefined, ["voice.speak"])).toEqual(["voice.speak"]);
  });

  it("merges explicit and default tags without duplicates", () => {
    expect(mergeRequestTags(["voice.speak", "custom"], ["voice.speak"])).toEqual([
      "voice.speak",
      "custom",
    ]);
  });

  it("returns undefined when both inputs are empty", () => {
    expect(mergeRequestTags(undefined, undefined)).toBeUndefined();
    expect(mergeRequestTags([], [])).toBeUndefined();
  });
});
