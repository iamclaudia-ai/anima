import { describe, expect, test } from "bun:test";
import { collectTrailingToolResults, isFeedbackSurvey, reportedTurnActive } from "./session";

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

  test("finds results behind a trailing system reminder", () => {
    // The actual shape that stranded every spinner, from proxy capture: the
    // CLI appends a `role: "system"` reminder AFTER the tool results. Of 62
    // captured agent requests carrying results, 10 looked like this.
    const messages = [
      assistantTurn("tool_1"),
      { role: "user", content: [toolResult("tool_1")] },
      { role: "system", content: "<system-reminder>…</system-reminder>" },
    ];
    expect(collectTrailingToolResults(messages)).toEqual([
      { tool_use_id: "tool_1", content: "ok", is_error: false },
    ]);
  });

  test("finds results behind several trailing non-user messages", () => {
    const messages = [
      assistantTurn("tool_1"),
      { role: "user", content: [toolResult("tool_1")] },
      { role: "system", content: "reminder one" },
      { role: "user", content: [{ type: "text", text: "<system-reminder>two</system-reminder>" }] },
    ];
    expect(collectTrailingToolResults(messages)).toHaveLength(1);
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

describe("reportedTurnActive", () => {
  test("reports the flag once we have a live read on the TUI", () => {
    expect(reportedTurnActive(true, true)).toBe(true);
    expect(reportedTurnActive(true, false)).toBe(false);
  });

  // The regression this exists for: a resume across a restart clears the
  // known-flag *because* `_turnActive` is stale — it reads false while a turn
  // nobody saw start is still running. Saying "no turn" there told the session
  // reconciler to retire the status mid-turn and stopped the spinner on a
  // session that was working.
  test("has no opinion when the turn state isn't known, rather than saying no", () => {
    expect(reportedTurnActive(false, false)).toBeUndefined();
    expect(reportedTurnActive(false, true)).toBeUndefined();
  });
});
