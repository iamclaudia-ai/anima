import { describe, expect, test } from "bun:test";
import {
  ESCALATE_AFTER_MS,
  ESCALATE_BLOCKED_AFTER_MS,
  escalateAfterMs,
  isAwaitingAcknowledgement,
  isBlockedOnPrompt,
  type AttentionSession,
} from "./useAttentionSessions";

/**
 * Two kinds of waiting, two thresholds. A finished session can sit for fifteen
 * minutes — the work is done and nothing is lost. A session blocked on a modal
 * prompt (#69) makes no progress at all until someone answers, and not knowing
 * that is the entire failure the detection exists to fix.
 */
const session = (runtimeStatus: AttentionSession["runtimeStatus"]): AttentionSession => ({
  sessionId: "ses_1",
  workspaceId: "ws_1",
  workspaceName: "anima",
  cwd: "/repo",
  title: null,
  firstPrompt: "review the PR",
  runtimeStatus,
  disposition: "open",
  lastActivity: "2026-08-15T00:00:00.000Z",
  waitingSince: "2026-08-15T00:00:00.000Z",
  snoozedUntil: null,
});

describe("attention escalation", () => {
  test("a blocked session counts as waiting on a human", () => {
    expect(isAwaitingAcknowledgement(session("awaiting_approval"))).toBe(true);
    expect(isAwaitingAcknowledgement(session("awaiting_input"))).toBe(true);
    expect(isBlockedOnPrompt(session("awaiting_approval"))).toBe(true);
  });

  test("a finished session still counts, and isn't called blocked", () => {
    expect(isAwaitingAcknowledgement(session("completed"))).toBe(true);
    expect(isBlockedOnPrompt(session("completed"))).toBe(false);
  });

  test("a working session is not waiting on anyone", () => {
    expect(isAwaitingAcknowledgement(session("running"))).toBe(false);
    expect(isAwaitingAcknowledgement(session("idle"))).toBe(false);
  });

  test("blocked escalates far sooner than finished", () => {
    expect(escalateAfterMs(session("awaiting_approval"))).toBe(ESCALATE_BLOCKED_AFTER_MS);
    expect(escalateAfterMs(session("completed"))).toBe(ESCALATE_AFTER_MS);
    expect(ESCALATE_BLOCKED_AFTER_MS).toBeLessThan(ESCALATE_AFTER_MS);
  });

  test("blocked still waits long enough that answering in the pane never banners", () => {
    // A prompt answered in a couple of seconds should raise nothing at all.
    expect(ESCALATE_BLOCKED_AFTER_MS).toBeGreaterThan(10_000);
  });
});
