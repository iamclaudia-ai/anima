import { describe, expect, test } from "bun:test";
import {
  mergeActivity,
  type AttentionSession,
  type SessionActivityPayload,
} from "./useAttentionSessions";

/**
 * The heartbeat's patch.
 *
 * `session.activity` fires about once a second per working session, and both
 * consumers of this store re-render on any change of snapshot identity. So the
 * property that makes the heartbeat affordable isn't what it does when a row
 * moves — it's what it does when one doesn't, which is the overwhelmingly
 * common case.
 */
const row = (over: Partial<AttentionSession> = {}): AttentionSession => ({
  sessionId: "ses_1",
  workspaceId: "ws_1",
  workspaceName: "anima",
  cwd: "/repo",
  title: null,
  firstPrompt: "review the PR",
  runtimeStatus: "running",
  disposition: "open",
  lastActivity: "2026-08-20T00:00:00.000Z",
  waitingSince: "2026-08-20T00:00:00.000Z",
  snoozedUntil: null,
  ...over,
});

const beat = (over: Partial<SessionActivityPayload> = {}): SessionActivityPayload => ({
  sessionId: "ses_1",
  runtimeStatus: "running",
  disposition: "open",
  title: null,
  firstPrompt: "review the PR",
  ...over,
});

describe("mergeActivity", () => {
  test("a beat that repeats what the row already says returns the same object", () => {
    const current = row();
    expect(mergeActivity(current, beat())).toBe(current);
  });

  test("moves the runtime status, which is what starts and stops a spinner", () => {
    const next = mergeActivity(row(), beat({ runtimeStatus: "completed" }));
    expect(next.runtimeStatus).toBe("completed");
  });

  test("moves the name, so a session named from its first prompt updates live", () => {
    const next = mergeActivity(row({ firstPrompt: null }), beat({ firstPrompt: "fix the pane" }));
    expect(next.firstPrompt).toBe("fix the pane");
  });

  test("a rename cleared on the server clears here — null is a value, not a gap", () => {
    const next = mergeActivity(row({ title: "Old name" }), beat({ title: null }));
    expect(next.title).toBeNull();
  });

  test("leaves the clock alone — how long you've waited isn't the beat's business", () => {
    const next = mergeActivity(row(), beat({ runtimeStatus: "completed" }));
    expect(next.waitingSince).toBe("2026-08-20T00:00:00.000Z");
    expect(next.lastActivity).toBe("2026-08-20T00:00:00.000Z");
  });

  test("keeps the fields a beat says nothing about", () => {
    const next = mergeActivity(row(), beat({ disposition: "needs_review" }));
    expect(next.workspaceName).toBe("anima");
    expect(next.cwd).toBe("/repo");
    expect(next.disposition).toBe("needs_review");
  });
});
