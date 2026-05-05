import { describe, expect, it } from "bun:test";
import {
  createSessionForWorkspace,
  loadSessionsForWorkspace,
  type GatewayCaller,
} from "./main-page-gateway";

describe("main-page-gateway", () => {
  it("returns the full session list when no pagination is requested", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const callGateway: GatewayCaller = async (method, params) => {
      calls.push({ method, params });
      if (method === "session.list_sessions") {
        return {
          sessions: [{ sessionId: "ses_1" }, { sessionId: "ses_2" }],
          total: 2,
          hasMore: false,
        } as unknown;
      }
      return null;
    };

    const result = await loadSessionsForWorkspace(callGateway, "/repo");
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["ses_1", "ses_2"]);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    // Without options, the helper omits limit/offset entirely.
    expect(calls[0]?.params).toEqual({ cwd: "/repo" });
  });

  it("forwards pagination options and reflects hasMore", async () => {
    const callGateway: GatewayCaller = async (_method, params) => {
      const offset = (params?.offset as number) ?? 0;
      const limit = (params?.limit as number) ?? 100;
      const all = Array.from({ length: 12 }, (_, i) => ({ sessionId: `ses_${i + 1}` }));
      const slice = all.slice(offset, offset + limit);
      return {
        sessions: slice,
        total: all.length,
        hasMore: offset + slice.length < all.length,
      } as unknown;
    };

    const page1 = await loadSessionsForWorkspace(callGateway, "/repo", { limit: 5, offset: 0 });
    expect(page1.sessions).toHaveLength(5);
    expect(page1.hasMore).toBe(true);

    const page3 = await loadSessionsForWorkspace(callGateway, "/repo", { limit: 5, offset: 10 });
    expect(page3.sessions).toHaveLength(2);
    expect(page3.hasMore).toBe(false);
  });

  it("creates a session", async () => {
    const callGateway: GatewayCaller = async (method) => {
      if (method === "session.create_session") return { sessionId: "ses_new" } as unknown;
      return null;
    };
    await expect(createSessionForWorkspace(callGateway, "/repo")).resolves.toBe("ses_new");
  });
});
