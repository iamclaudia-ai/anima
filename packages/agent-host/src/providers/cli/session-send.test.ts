/**
 * Send-confirmation contract for the CLI runtime (#47, Part D). The send path
 * confirms a paste landed via EITHER an SSE turn-start OR a JSONL receipt — the
 * latter is the only signal an in-tool steer produces. Drives the private
 * waitForSendConfirm directly (it only races EventEmitter signals, no tmux).
 */
import { describe, expect, test } from "bun:test";
import { ClaudeCliSession } from "./session";

interface SendSession {
  emit(event: string, ...args: unknown[]): boolean;
  waitForSendConfirm(timeoutMs: number): Promise<boolean>;
}

function makeSession(): SendSession {
  return new ClaudeCliSession(
    "test-id",
    { cwd: "/tmp/anima-send-test", model: "claude-sonnet-4-6" },
    false,
    {},
  ) as unknown as SendSession;
}

describe("ClaudeCliSession send confirmation", () => {
  test("confirms on turn_started (fresh prompt / promoted steer)", async () => {
    const s = makeSession();
    const confirm = s.waitForSendConfirm(1000);
    s.emit("turn_started");
    expect(await confirm).toBe(true);
  });

  test("confirms on prompt_received (JSONL receipt — in-tool steer)", async () => {
    const s = makeSession();
    const confirm = s.waitForSendConfirm(1000);
    s.emit("prompt_received");
    expect(await confirm).toBe(true);
  });

  test("returns false on timeout with neither signal", async () => {
    const s = makeSession();
    expect(await s.waitForSendConfirm(60)).toBe(false);
  });

  test("a later signal after timeout does not throw or double-resolve", async () => {
    const s = makeSession();
    const confirm = s.waitForSendConfirm(40);
    expect(await confirm).toBe(false);
    // listeners are torn down on timeout — emitting now is a harmless no-op
    expect(() => s.emit("turn_started")).not.toThrow();
    expect(() => s.emit("prompt_received")).not.toThrow();
  });
});
