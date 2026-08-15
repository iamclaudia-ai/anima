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
  setWorkspaceActiveSession,
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
});
