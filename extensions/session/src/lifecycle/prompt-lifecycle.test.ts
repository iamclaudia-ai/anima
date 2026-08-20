import { describe, expect, test } from "bun:test";
import { firstPromptTitle } from "./prompt-lifecycle";

/**
 * Naming a session from the prompt that starts it.
 *
 * The name used to come from the reconciler, which reads it back out of the
 * transcript on disk — so a brand-new session was eight hex digits of its id
 * until its first turn had produced a file to read. The prompt is right there
 * at dispatch; this is the guard around writing it then instead.
 *
 * The whole risk is overwriting something better, so that's what these pin.
 */
describe("firstPromptTitle", () => {
  test("names an untitled session from its opening prompt", () => {
    expect(
      firstPromptTitle({
        content: "add icons for all the dispositions",
        existing: null,
        existingMetadata: null,
      }),
    ).toBe("add icons for all the dispositions");
  });

  test("never outranks an explicit rename", () => {
    expect(
      firstPromptTitle({
        content: "and now fix the spinner",
        existing: { title: "Active pane overhaul" },
        existingMetadata: null,
      }),
    ).toBeNull();
  });

  test("is the *first* prompt, not the latest — a second turn changes nothing", () => {
    expect(
      firstPromptTitle({
        content: "and now fix the spinner",
        existing: {},
        existingMetadata: { firstPrompt: "add icons for all the dispositions" },
      }),
    ).toBeNull();
  });

  test("a prompt with no text to speak of leaves the name alone", () => {
    expect(
      firstPromptTitle({
        content: [{ type: "image", source: { data: "…" } }],
        existing: null,
        existingMetadata: null,
      }),
    ).toBeNull();
  });
});
