import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import {
  closeSessionDb,
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
