import { describe, expect, test } from "bun:test";
import { isFeedbackSurvey } from "./session";

describe("isFeedbackSurvey", () => {
  test("matches the rendered feedback survey options row", () => {
    const pane = [
      "● How is Claude doing this session? (optional)",
      "  1: Bad     2: Fine   3: Good    0: Dismiss",
      "",
      "› ",
    ].join("\n");
    expect(isFeedbackSurvey(pane)).toBe(true);
  });

  test("ignores a normal idle pane", () => {
    const pane = ["● Done (8s)", "", "› ", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join(
      "\n",
    );
    expect(isFeedbackSurvey(pane)).toBe(false);
  });

  test("ignores scrollback that only mentions the survey question", () => {
    // The question text alone (e.g. discussed in conversation) must not match —
    // only the distinctive single-line options row counts.
    const pane = [
      "user: another thing — How is Claude doing this session? shows periodically",
      "assistant: right, options 1: Bad through 3: Good, and it's always 3",
      "› ",
    ].join("\n");
    expect(isFeedbackSurvey(pane)).toBe(false);
  });
});
