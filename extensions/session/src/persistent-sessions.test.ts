import { describe, expect, it } from "bun:test";
import {
  resolvePersistentSessionForCwd,
  rotatePersistentSessions,
  type PersistentSessionEntry,
} from "./persistent-sessions";

function createStore(entries: Record<string, PersistentSessionEntry> = {}) {
  let data = structuredClone(entries);

  return {
    getEntries() {
      return data;
    },
    setEntries(next: Record<string, PersistentSessionEntry>) {
      data = structuredClone(next);
    },
    snapshot() {
      return structuredClone(data);
    },
  };
}

describe("persistent sessions", () => {
  it("increments message count when the cwd session is active", async () => {
    const store = createStore({
      "/repo/project": {
        sessionId: "session-1",
        messageCount: 2,
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    const sessionId = await resolvePersistentSessionForCwd({
      cwd: "/repo/project",
      store,
      listActiveSessions: async () => [{ id: "session-1" }],
      createSession: async () => {
        throw new Error("should not create");
      },
      log: { info() {} },
    });

    expect(sessionId).toBe("session-1");
    expect(store.snapshot()["/repo/project"]?.messageCount).toBe(3);
  });

  it("returns the stored session id for resume when agent-host no longer has it", async () => {
    const store = createStore({
      "/repo/project": {
        sessionId: "session-2",
        messageCount: 5,
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    const sessionId = await resolvePersistentSessionForCwd({
      cwd: "/repo/project",
      store,
      listActiveSessions: async () => [],
      createSession: async () => {
        throw new Error("should not create");
      },
      log: { info() {} },
    });

    expect(sessionId).toBe("session-2");
    expect(store.snapshot()["/repo/project"]?.messageCount).toBe(5);
  });

  it("creates a new persistent session when the cwd has none", async () => {
    const store = createStore();

    const sessionId = await resolvePersistentSessionForCwd({
      cwd: "/repo/project",
      store,
      listActiveSessions: async () => [],
      createSession: async (cwd) => `created:${cwd}`,
      log: { info() {} },
      now: () => "2026-03-21T12:00:00.000Z",
    });

    expect(sessionId).toBe("created:/repo/project");
    expect(store.snapshot()).toEqual({
      "/repo/project": {
        sessionId: "created:/repo/project",
        messageCount: 1,
        createdAt: "2026-03-21T12:00:00.000Z",
      },
    });
  });

  it("rotates sessions that exceed message or age limits", () => {
    const store = createStore({
      "/repo/keep": {
        sessionId: "keep-1",
        messageCount: 10,
        createdAt: "2026-03-21T11:00:00.000Z",
      },
      "/repo/by-messages": {
        sessionId: "rotate-1",
        messageCount: 200,
        createdAt: "2026-03-21T11:00:00.000Z",
      },
      "/repo/by-age": {
        sessionId: "rotate-2",
        messageCount: 1,
        createdAt: "2026-03-20T00:00:00.000Z",
      },
    });

    const result = rotatePersistentSessions({
      store,
      maxMessages: 200,
      maxAgeHours: 24,
      log: { info() {} },
      now: () => new Date("2026-03-21T12:00:00.000Z").getTime(),
    });

    expect(result).toEqual({
      rotated: ["/repo/by-messages", "/repo/by-age"],
      checked: 3,
    });
    expect(store.snapshot()).toEqual({
      "/repo/keep": {
        sessionId: "keep-1",
        messageCount: 10,
        createdAt: "2026-03-21T11:00:00.000Z",
      },
    });
  });
});
