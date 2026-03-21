import { describe, expect, it } from "bun:test";
import {
  createSessionForWorkspace,
  loadMainPageBootstrapData,
  loadSessionsForWorkspace,
  type GatewayCaller,
} from "./main-page-gateway";

describe("main-page-gateway", () => {
  it("loads workspace and matching session from bootstrap data", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const callGateway: GatewayCaller = async (method, params) => {
      calls.push({ method, params });
      if (method === "session.list_workspaces") {
        return {
          workspaces: [
            { id: "ws_1", name: "One", cwd: "/one", general: false },
            { id: "ws_2", name: "Two", cwd: "/two", general: true },
          ],
        } as unknown;
      }
      if (method === "session.list_sessions") {
        return {
          sessions: [{ sessionId: "ses_123" }, { sessionId: "ses_other" }],
        } as unknown;
      }
      return null;
    };

    const result = await loadMainPageBootstrapData(callGateway, {
      workspaceId: "ws_2",
      sessionId: "ses_123",
      hasActiveSession: false,
    });

    expect(result.activeWorkspace?.id).toBe("ws_2");
    expect(result.activeSessionId).toBe("ses_123");
    expect(result.sessions.length).toBe(2);
    expect(calls.map((call) => call.method)).toEqual([
      "session.list_workspaces",
      "session.list_sessions",
    ]);
    expect(calls[1]?.params).toEqual({ cwd: "/two" });
  });

  it("returns empty bootstrap data when no workspaces exist", async () => {
    const callGateway: GatewayCaller = async () => ({ workspaces: [] }) as unknown;
    const result = await loadMainPageBootstrapData(callGateway, {
      workspaceId: undefined,
      sessionId: "ses_123",
      hasActiveSession: false,
    });

    expect(result.workspaces).toEqual([]);
    expect(result.activeWorkspace).toBeNull();
    expect(result.sessions).toEqual([]);
    expect(result.activeSessionId).toBeNull();
  });

  it("loads sessions for a workspace and creates a session", async () => {
    const callGateway: GatewayCaller = async (method) => {
      if (method === "session.list_sessions")
        return { sessions: [{ sessionId: "ses_1" }] } as unknown;
      if (method === "session.create_session") return { sessionId: "ses_new" } as unknown;
      return null;
    };

    await expect(loadSessionsForWorkspace(callGateway, "/repo")).resolves.toEqual([
      { sessionId: "ses_1" },
    ]);
    await expect(createSessionForWorkspace(callGateway, "/repo")).resolves.toBe("ses_new");
  });
});
