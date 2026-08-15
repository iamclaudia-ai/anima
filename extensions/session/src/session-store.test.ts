import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import {
  closeSessionDb,
  setSessionTitle,
  getStoredSession,
  listSubagentSessions,
  listWorkspaceSessions,
  setSessionDisposition,
  setWorkspaceActiveSession,
  touchSession,
  updateSessionRuntime,
  upsertSession,
} from "./session-store";

describe("session store", () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof spyOn>;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), "claudia-session-store-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    closeSessionDb();
    homedirSpy.mockRestore();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("keeps a user rename separate from the derived title", () => {
    upsertSession({
      id: "ses_rename",
      workspaceId: "ws_rename",
      providerSessionId: "ses_rename",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
      runtimeStatus: "idle",
      metadata: { firstPrompt: "morning babe, let's look at the nav" },
      lastActivity: new Date().toISOString(),
    });

    const before = listWorkspaceSessions("ws_rename")[0];
    expect(before?.title).toBeUndefined();
    expect(before?.firstPrompt).toBe("morning babe, let's look at the nav");

    expect(setSessionTitle("ses_rename", "  Nav overhaul  ")).toBe(true);

    const after = listWorkspaceSessions("ws_rename")[0];
    // Trimmed, and the derived title survives underneath as the fallback the
    // rename UI shows as a placeholder.
    expect(after?.title).toBe("Nav overhaul");
    expect(after?.firstPrompt).toBe("morning babe, let's look at the nav");
  });

  it("clears a rename back to the derived title", () => {
    upsertSession({
      id: "ses_clear",
      workspaceId: "ws_clear",
      providerSessionId: "ses_clear",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
      runtimeStatus: "idle",
      metadata: { firstPrompt: "fix the reaper" },
      lastActivity: new Date().toISOString(),
    });

    setSessionTitle("ses_clear", "Reaper fix");
    // Whitespace-only is a clear, not a rename to spaces.
    setSessionTitle("ses_clear", "   ");

    const row = listWorkspaceSessions("ws_clear")[0];
    expect(row?.title).toBeUndefined();
    expect(row?.firstPrompt).toBe("fix the reaper");
  });

  it("reports an unknown session rather than silently succeeding", () => {
    expect(setSessionTitle("ses_does_not_exist", "nope")).toBe(false);
  });

  it("persists chat sessions and subagent child sessions", () => {
    upsertSession({
      id: "ses_parent",
      workspaceId: "ws_1",
      providerSessionId: "ses_parent",
      model: "claude-opus-4-6",
      agent: "claude",
      purpose: "chat",
      runtimeStatus: "idle",
      metadata: { firstPrompt: "hello" },
    });
    setWorkspaceActiveSession("ws_1", "ses_parent");

    upsertSession({
      id: "subagent_1",
      workspaceId: "ws_1",
      providerSessionId: "subagent_1",
      model: "gpt-5.2-codex",
      agent: "codex",
      purpose: "review",
      parentSessionId: "ses_parent",
      runtimeStatus: "running",
      metadata: { prompt: "review this" },
    });

    const chat = listWorkspaceSessions("ws_1");
    expect(chat).toHaveLength(1);
    expect(chat[0]?.sessionId).toBe("ses_parent");
    expect(chat[0]?.firstPrompt).toBe("hello");

    const subagents = listSubagentSessions({ parentSessionId: "ses_parent" });
    expect(subagents).toHaveLength(1);
    expect(subagents[0]?.id).toBe("subagent_1");
    expect(subagents[0]?.purpose).toBe("review");
    expect(subagents[0]?.runtimeStatus).toBe("running");

    const parent = getStoredSession("ses_parent");
    expect(parent?.id).toBe("ses_parent");
    expect(parent?.model).toBe("claude-opus-4-6");
  });

  describe("status axes", () => {
    const seed = (id: string) =>
      upsertSession({
        id,
        workspaceId: "ws_status",
        providerSessionId: id,
        model: "claude-opus-5",
        agent: "claude",
        purpose: "chat",
      });

    it("defaults a new session to idle and open", () => {
      seed("ses_defaults");
      const stored = getStoredSession("ses_defaults");
      expect(stored?.runtimeStatus).toBe("idle");
      expect(stored?.disposition).toBe("open");
    });

    it("accepts the awaiting states the pre-024 CHECK constraint rejected", () => {
      seed("ses_awaiting");
      expect(touchSession("ses_awaiting", "awaiting_approval")).toEqual({
        from: "idle",
        to: "awaiting_approval",
      });
      expect(getStoredSession("ses_awaiting")?.runtimeStatus).toBe("awaiting_approval");
    });

    // The whole event design rests on this: the lifecycle calls touchSession
    // per streamed event, so a status write that didn't move anything must not
    // look like a transition or every token would put a message on the bus.
    it("reports a transition only when the runtime status actually moves", () => {
      seed("ses_transition");
      expect(touchSession("ses_transition", "running")).toEqual({ from: "idle", to: "running" });
      expect(touchSession("ses_transition", "running")).toBeNull();
      expect(touchSession("ses_transition")).toBeNull();
      expect(updateSessionRuntime("ses_transition", "completed")).toEqual({
        from: "running",
        to: "completed",
      });
      expect(updateSessionRuntime("ses_transition", "completed")).toBeNull();
    });

    it("reports nothing for a session that does not exist", () => {
      expect(touchSession("ses_missing", "running")).toBeNull();
      expect(setSessionDisposition("ses_missing", "resolved")).toBeNull();
    });

    // The reconciler upserts every session on every pass. If that reset the
    // human axis, marking something resolved would last until the next sweep.
    it("keeps disposition through an upsert", () => {
      seed("ses_keeps");
      setSessionDisposition("ses_keeps", "needs_review");
      seed("ses_keeps");
      expect(getStoredSession("ses_keeps")?.disposition).toBe("needs_review");
    });

    it("hides resolved and archived from the default list, and shows them on request", () => {
      seed("ses_open");
      seed("ses_resolved");
      seed("ses_archived");
      setSessionDisposition("ses_resolved", "resolved");
      setSessionDisposition("ses_archived", "archived");

      const visible = listWorkspaceSessions("ws_status").map((s) => s.sessionId);
      expect(visible).toContain("ses_open");
      expect(visible).not.toContain("ses_resolved");
      expect(visible).not.toContain("ses_archived");

      const resolvedOnly = listWorkspaceSessions("ws_status", {
        includeDispositions: ["resolved"],
      }).map((s) => s.sessionId);
      expect(resolvedOnly).toEqual(["ses_resolved"]);

      // An empty allow-list means "no filter given", not "match nothing" —
      // the latter would compile to `IN ()`, which SQLite rejects.
      expect(() => listWorkspaceSessions("ws_status", { includeDispositions: [] })).not.toThrow();
    });

    it("carries both axes onto the list rows", () => {
      seed("ses_axes");
      touchSession("ses_axes", "awaiting_input");
      setSessionDisposition("ses_axes", "blocked");

      const row = listWorkspaceSessions("ws_status").find((s) => s.sessionId === "ses_axes");
      expect(row?.runtimeStatus).toBe("awaiting_input");
      expect(row?.disposition).toBe("blocked");
    });
  });
});
