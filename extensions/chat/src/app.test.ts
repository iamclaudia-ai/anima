import { describe, expect, it } from "bun:test";
import { getDraftStorageKey } from "./app";

describe("chat draft storage key", () => {
  it("uses session-scoped key when workspace and session are present", () => {
    expect(getDraftStorageKey({ workspaceId: "ws_123", sessionId: "ses_456" })).toBe(
      "claudia:draft:ws_123:ses_456",
    );
  });

  it("uses session-scoped key when only session is present", () => {
    expect(getDraftStorageKey({ sessionId: "ses_456" })).toBe("claudia:draft:ses_456");
  });

  it("falls back to global key when no session is present", () => {
    expect(getDraftStorageKey()).toBe("claudia-draft");
  });
});
