import { describe, expect, test } from "bun:test";
import { classifyEntry, encodeCwd, resolveOwnSessionPath } from "./jsonl";

describe("encodeCwd", () => {
  test("replaces / and . with -", () => {
    expect(encodeCwd("/Users/me/.hammerspoon")).toBe("-Users-me--hammerspoon");
    expect(encodeCwd("/Users/michael/Projects/iamclaudia-ai/anima")).toBe(
      "-Users-michael-Projects-iamclaudia-ai-anima",
    );
  });
});

describe("resolveOwnSessionPath", () => {
  test("builds canonical ~/.claude/projects/<enc>/<id>.jsonl when nothing exists", () => {
    const p = resolveOwnSessionPath("/tmp/anima-no-such-dir-xyz", "abc-123");
    expect(p.endsWith("/.claude/projects/-tmp-anima-no-such-dir-xyz/abc-123.jsonl")).toBe(true);
  });
});

describe("classifyEntry", () => {
  test("normal user prompt (array content)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello babe" }] },
      timestamp: "2026-05-29T19:00:00.000Z",
    });
    expect(classifyEntry(line)).toEqual({
      kind: "user_prompt",
      text: "hello babe",
      timestamp: "2026-05-29T19:00:00.000Z",
    });
  });

  test("normal user prompt (string content)", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
    expect(classifyEntry(line)).toEqual({ kind: "user_prompt", text: "hi", timestamp: undefined });
  });

  test("interrupt marker (text response)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      interruptedMessageId: "msg_01KHEVg7ZNAM5X5LJSsd2ZHT",
    });
    expect(classifyEntry(line)).toMatchObject({ kind: "interrupt", forToolUse: false });
  });

  test("interrupt marker (for tool use)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      },
      interruptedMessageId: "msg_012xnnjLhUzvwP5S2EUgXYDP",
    });
    expect(classifyEntry(line)).toMatchObject({ kind: "interrupt", forToolUse: true });
  });

  test("tool_result continuation is not a prompt", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    });
    expect(classifyEntry(line)).toEqual({ kind: "other" });
  });

  test("queue enqueue carries content", () => {
    const line = JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      content: "steer this",
      timestamp: "2026-05-12T16:10:19.067Z",
    });
    expect(classifyEntry(line)).toEqual({
      kind: "enqueue",
      content: "steer this",
      timestamp: "2026-05-12T16:10:19.067Z",
    });
  });

  test("queue dequeue and remove", () => {
    expect(
      classifyEntry(JSON.stringify({ type: "queue-operation", operation: "dequeue" })),
    ).toEqual({ kind: "dequeue", timestamp: undefined });
    expect(classifyEntry(JSON.stringify({ type: "queue-operation", operation: "remove" }))).toEqual(
      { kind: "remove", timestamp: undefined },
    );
  });

  test("assistant and summary entries are other", () => {
    expect(classifyEntry(JSON.stringify({ type: "assistant", message: {} }))).toEqual({
      kind: "other",
    });
    expect(classifyEntry(JSON.stringify({ type: "summary", summary: "x" }))).toEqual({
      kind: "other",
    });
  });

  test("blank and unparseable lines return null", () => {
    expect(classifyEntry("")).toBeNull();
    expect(classifyEntry("   ")).toBeNull();
    expect(classifyEntry("{not json")).toBeNull();
  });
});
