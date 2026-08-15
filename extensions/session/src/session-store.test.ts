import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import {
  closeSessionDb,
  setSessionTitle,
  getStoredSession,
  listSubagentSessions,
  listAttentionSessions,
  listWorkspaceSessions,
  setSessionDisposition,
  setSessionSnooze,
  setWorkspaceActiveSession,
  touchSession,
  updateSessionRuntime,
  upsertSession,
} from "./session-store";
import { createWorkspace } from "./workspace";

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

    // Marking something done must not delete it from the sidebar. `resolved`
    // drops out of the ACTIVE queue and stays in its workspace folder; only
    // `archived` leaves the tree. Without that split, clearing the queue would
    // quietly empty every folder.
    it("keeps resolved sessions in the tree and hides only archived", () => {
      seed("ses_open");
      seed("ses_resolved");
      seed("ses_archived");
      setSessionDisposition("ses_resolved", "resolved");
      setSessionDisposition("ses_archived", "archived");

      const visible = listWorkspaceSessions("ws_status").map((s) => s.sessionId);
      expect(visible).toContain("ses_open");
      expect(visible).toContain("ses_resolved");
      expect(visible).not.toContain("ses_archived");

      const resolvedOnly = listWorkspaceSessions("ws_status", {
        includeDispositions: ["resolved"],
      }).map((s) => s.sessionId);
      expect(resolvedOnly).toEqual(["ses_resolved"]);

      // An empty allow-list means "no filter given", not "match nothing" —
      // the latter would compile to `IN ()`, which SQLite rejects.
      expect(() => listWorkspaceSessions("ws_status", { includeDispositions: [] })).not.toThrow();
    });

    // The predicate behind both the banner and the active pane.
    describe("attention list", () => {
      const NOW = "2026-08-15T12:00:00.000Z";

      // The queue is "everything unresolved", not "everything busy". An idle
      // session with work still open belongs in it — that's the point of a
      // queue, and resolving is how it gets shorter.
      it("holds every unresolved session, whatever it is doing", () => {
        seed("ses_running");
        seed("ses_done_open");
        seed("ses_done_resolved");
        seed("ses_idle");
        touchSession("ses_running", "running");
        touchSession("ses_done_open", "completed");
        touchSession("ses_done_resolved", "completed");
        setSessionDisposition("ses_done_resolved", "resolved");

        const ids = listAttentionSessions({ now: NOW }).map((s) => s.sessionId);
        expect(ids).toContain("ses_running");
        expect(ids).toContain("ses_done_open");
        expect(ids).toContain("ses_idle");
        expect(ids).not.toContain("ses_done_resolved");
      });

      // Reopening old work from search is a normal way to start, and a row you
      // are looking at that offers no way to act on itself is just a gap.
      it("always includes the session the tab has open, even resolved", () => {
        seed("ses_reopened");
        touchSession("ses_reopened", "completed");
        setSessionDisposition("ses_reopened", "resolved");

        expect(listAttentionSessions({ now: NOW }).map((s) => s.sessionId)).not.toContain(
          "ses_reopened",
        );
        const withCurrent = listAttentionSessions({
          now: NOW,
          includeSessionId: "ses_reopened",
        }).map((s) => s.sessionId);
        expect(withCurrent).toContain("ses_reopened");
      });

      // Libby's summarization runs produce a session per conversation and
      // nobody ever acts on one — they'd swamp a list meant to answer "what am
      // I in the middle of".
      it("excludes configured workspaces, by name or cwd", () => {
        const machinery = createWorkspace({ name: "libby", cwd: join(tmpHome, "libby") });
        upsertSession({
          id: "ses_machinery",
          workspaceId: machinery.id,
          providerSessionId: "ses_machinery",
          model: "claude-opus-5",
          agent: "claude",
          purpose: "chat",
        });
        seed("ses_mine");

        const byName = listAttentionSessions({
          now: NOW,
          excludeWorkspaces: ["Libby"],
        }).map((s) => s.sessionId);
        expect(byName).toContain("ses_mine");
        expect(byName).not.toContain("ses_machinery");

        const byCwd = listAttentionSessions({
          now: NOW,
          excludeWorkspaces: [join(tmpHome, "libby")],
        }).map((s) => s.sessionId);
        expect(byCwd).not.toContain("ses_machinery");

        // Opening one deliberately still gives you a row you can act on.
        const opened = listAttentionSessions({
          now: NOW,
          excludeWorkspaces: ["libby"],
          includeSessionId: "ses_machinery",
        }).map((s) => s.sessionId);
        expect(opened).toContain("ses_machinery");
      });

      it("keeps a snoozed session visible when it is the open one", () => {
        seed("ses_snoozed_current");
        touchSession("ses_snoozed_current", "completed");
        setSessionSnooze("ses_snoozed_current", "2026-08-15T23:00:00.000Z");

        expect(listAttentionSessions({ now: NOW }).map((s) => s.sessionId)).not.toContain(
          "ses_snoozed_current",
        );
        expect(
          listAttentionSessions({ now: NOW, includeSessionId: "ses_snoozed_current" }).map(
            (s) => s.sessionId,
          ),
        ).toContain("ses_snoozed_current");
      });

      it("hides a snoozed session until its timer passes", () => {
        seed("ses_snooze");
        touchSession("ses_snooze", "completed");
        setSessionSnooze("ses_snooze", "2026-08-15T12:30:00.000Z");
        setSessionDisposition("ses_snooze", "snoozed");

        const during = listAttentionSessions({ now: NOW }).map((s) => s.sessionId);
        expect(during).not.toContain("ses_snooze");

        // "Remind me later" has to actually remind, or it's just dismissal
        // with extra steps.
        const after = listAttentionSessions({ now: "2026-08-15T13:00:00.000Z" }).map(
          (s) => s.sessionId,
        );
        expect(after).toContain("ses_snooze");
      });

      it("clears a snooze outright", () => {
        seed("ses_unsnooze");
        touchSession("ses_unsnooze", "completed");
        setSessionSnooze("ses_unsnooze", "2026-08-15T23:00:00.000Z");
        expect(listAttentionSessions({ now: NOW }).map((s) => s.sessionId)).not.toContain(
          "ses_unsnooze",
        );

        setSessionSnooze("ses_unsnooze", null);
        expect(listAttentionSessions({ now: NOW }).map((s) => s.sessionId)).toContain(
          "ses_unsnooze",
        );
      });

      it("preserves other metadata when snoozing", () => {
        upsertSession({
          id: "ses_meta",
          workspaceId: "ws_status",
          providerSessionId: "ses_meta",
          model: "claude-opus-5",
          agent: "claude",
          purpose: "chat",
          metadata: { firstPrompt: "review the PR" },
        });
        setSessionSnooze("ses_meta", "2026-08-15T23:00:00.000Z");
        expect(getStoredSession("ses_meta")?.metadata?.firstPrompt).toBe("review the PR");
      });

      it("carries what the banner needs to render a row", () => {
        seed("ses_render");
        touchSession("ses_render", "awaiting_input");

        const row = listAttentionSessions({ now: NOW }).find((s) => s.sessionId === "ses_render");
        expect(row).toMatchObject({
          workspaceId: "ws_status",
          runtimeStatus: "awaiting_input",
          disposition: "open",
        });
        expect(row?.lastActivity).toBeTruthy();
        expect(row?.workspaceName).toBeTruthy();
      });
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
