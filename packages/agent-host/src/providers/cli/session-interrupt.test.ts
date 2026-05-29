/**
 * Interrupt contract for the CLI runtime (#47). Drives the private
 * handleProxyEvent/abortTurn directly — they touch no tmux/proxy, only event
 * state — so we can verify the suppress-by-reqId behavior that the live web-UI
 * test exercises end-to-end.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeCliSession } from "./session";

interface Sse {
  type: string;
  stop_reason?: string;
  delta?: { text?: string; stop_reason?: string };
}

type Ctx = { isAgentTurn: boolean; reqId: string };

/**
 * Standalone view of the private members we drive — NOT an intersection with
 * ClaudeCliSession, which would collapse to `never` (the members are private on
 * the class). The `as unknown as` cast is the seam.
 */
interface TestSession {
  on(event: "sse", listener: (e: Sse) => void): void;
  _turnActive: boolean;
  handleProxyEvent(ev: Sse, ctx: Ctx): void;
  abortTurn(source: string): void;
}

function makeSession(): { s: TestSession; sse: Sse[] } {
  const s = new ClaudeCliSession(
    "test-id",
    { cwd: "/tmp/anima-interrupt-test", model: "claude-sonnet-4-6" },
    false,
    {},
  ) as unknown as TestSession;
  const sse: Sse[] = [];
  s.on("sse", (e) => sse.push(e));
  return { s, sse };
}

describe("ClaudeCliSession interrupt", () => {
  test("suppresses the interrupted request's drain by reqId", () => {
    const { s, sse } = makeSession();
    const a: Ctx = { isAgentTurn: true, reqId: "AAAA" };
    s._turnActive = true;
    s.handleProxyEvent({ type: "message_start" }, a);
    s.handleProxyEvent({ type: "content_block_delta", delta: { text: "hi" } }, a);

    s.abortTurn("escape");

    // Upstream keeps streaming server-side after the abort — all dropped.
    s.handleProxyEvent({ type: "content_block_delta", delta: { text: "MORE" } }, a);
    s.handleProxyEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }, a);
    s.handleProxyEvent({ type: "message_stop" }, a);

    expect(sse.map((e) => e.type)).toEqual(["message_start", "content_block_delta", "turn_stop"]);
    expect(sse.find((e) => e.type === "turn_stop")?.stop_reason).toBe("abort");
    expect(sse.some((e) => e.delta?.text === "MORE")).toBe(false);
  });

  test("a fresh turn during the drain still flows (different reqId)", () => {
    const { s, sse } = makeSession();
    const a: Ctx = { isAgentTurn: true, reqId: "AAAA" };
    const b: Ctx = { isAgentTurn: true, reqId: "BBBB" };
    s._turnActive = true;
    s.handleProxyEvent({ type: "message_start" }, a);
    s.abortTurn("escape");
    s.handleProxyEvent({ type: "content_block_delta", delta: { text: "drain" } }, a); // dropped

    s._turnActive = true;
    s.handleProxyEvent({ type: "message_start" }, b);
    s.handleProxyEvent({ type: "content_block_delta", delta: { text: "fresh" } }, b);

    const texts = sse.filter((e) => e.type === "content_block_delta").map((e) => e.delta?.text);
    expect(texts).toEqual(["fresh"]);
  });

  test("idempotent — both interrupt paths produce exactly one turn_stop{abort}", () => {
    const { s, sse } = makeSession();
    const a: Ctx = { isAgentTurn: true, reqId: "AAAA" };
    s._turnActive = true;
    s.handleProxyEvent({ type: "message_start" }, a);

    s.abortTurn("escape"); // web-UI path
    s.abortTurn("jsonl_marker"); // direct-tmux marker, arrives moments later

    const aborts = sse.filter((e) => e.type === "turn_stop" && e.stop_reason === "abort");
    expect(aborts.length).toBe(1);
  });

  test("no-ops when there is no active turn to abort", () => {
    const { s, sse } = makeSession();
    s.abortTurn("escape");
    expect(sse.length).toBe(0);
  });
});
