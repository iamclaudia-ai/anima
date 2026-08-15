import { describe, expect, test } from "bun:test";
import { collectTrailingToolResults, isFeedbackSurvey } from "./session";

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

describe("collectTrailingToolResults", () => {
  const toolResult = (id: string, content = "ok") => ({
    type: "tool_result",
    tool_use_id: id,
    content,
    is_error: false,
  });
  const assistantTurn = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Bash", input: {} }],
  });

  test("collects results from the last message", () => {
    const messages = [
      { role: "user", content: "run the tests" },
      assistantTurn("tool_1"),
      { role: "user", content: [toolResult("tool_1")] },
    ];
    expect(collectTrailingToolResults(messages)).toEqual([
      { tool_use_id: "tool_1", content: "ok", is_error: false },
    ]);
  });

  test("finds results displaced from the last slot by a trailing message", () => {
    // The spinner-never-stops regression: the CLI appends a system-reminder
    // user message after the tool results, so a last-message-only scan sees
    // nothing and the tool call spins forever.
    const messages = [
      assistantTurn("tool_1"),
      { role: "user", content: [toolResult("tool_1")] },
      { role: "user", content: [{ type: "text", text: "<system-reminder>…</system-reminder>" }] },
    ];
    expect(collectTrailingToolResults(messages)).toEqual([
      { tool_use_id: "tool_1", content: "ok", is_error: false },
    ]);
  });

  test("skips a plain-string trailing message without ending the scan", () => {
    const messages = [
      assistantTurn("tool_1"),
      { role: "user", content: [toolResult("tool_1")] },
      { role: "user", content: "<system-reminder>…</system-reminder>" },
    ];
    expect(collectTrailingToolResults(messages)).toHaveLength(1);
  });

  test("preserves request order across messages and blocks", () => {
    const messages = [
      assistantTurn("tool_1"),
      { role: "user", content: [toolResult("tool_1", "first"), toolResult("tool_2", "second")] },
      { role: "user", content: [toolResult("tool_3", "third")] },
    ];
    expect(collectTrailingToolResults(messages).map((r) => r.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("stops at the first assistant message", () => {
    // Results from earlier tool loops were already emitted; re-collecting them
    // would replay finished tool calls on every continuation request.
    const messages = [
      assistantTurn("old_tool"),
      { role: "user", content: [toolResult("old_tool", "stale")] },
      { role: "assistant", content: [{ type: "text", text: "now the next one" }] },
      assistantTurn("new_tool"),
      { role: "user", content: [toolResult("new_tool", "fresh")] },
    ];
    expect(collectTrailingToolResults(messages).map((r) => r.content)).toEqual(["fresh"]);
  });

  test("returns nothing when the trailing run has no tool results", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
    expect(collectTrailingToolResults(messages)).toEqual([]);
  });

  test("tolerates empty and malformed input", () => {
    expect(collectTrailingToolResults([])).toEqual([]);
    expect(collectTrailingToolResults([null, undefined, 42])).toEqual([]);
    expect(collectTrailingToolResults([{ role: "user", content: [null, "text"] }])).toEqual([]);
  });
});
