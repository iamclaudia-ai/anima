import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import {
  closeSessionDb,
  getSessionDb,
  setSessionTitle,
  getStoredSession,
  listSubagentSessions,
  listAttentionSessions,
  listWorkspaceSessions,
  setSessionDisposition,
  setSessionSnooze,
  setWorkspaceActiveSession,
  touchSession,
  updateSessionMetadata,
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

  /**
   * The reconciler upserts every session it discovers, without a runtime
   * status, on every pass. Before this the upsert reset the column to `idle` —
   * which nothing noticed while the only states that mattered were re-written
   * by a stream of events several times a second. A session blocked on a modal
   * prompt writes `awaiting_approval` exactly once and then goes silent by
   * definition, so it was reset within seconds, every time.
   */
  it("does not reset runtime status on an upsert that omits one", () => {
    const base = {
      id: "ses_status",
      workspaceId: "ws_status",
      providerSessionId: "ses_status",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat" as const,
      lastActivity: new Date().toISOString(),
    };
    upsertSession({ ...base, runtimeStatus: "idle" });
    touchSession("ses_status", "awaiting_approval");

    // A reconciler pass: same row, no opinion about runtime status.
    upsertSession(base);
    expect(getStoredSession("ses_status")?.runtimeStatus).toBe("awaiting_approval");

    // An upsert that *does* state one still wins.
    upsertSession({ ...base, runtimeStatus: "running" });
    expect(getStoredSession("ses_status")?.runtimeStatus).toBe("running");
  });

  /**
   * No caller holds the whole metadata object — the reconciler knows what it
   * reads off disk, the lifecycle knows when a turn ended, the modal watcher
   * knows when a prompt appeared. While metadata was replaced rather than
   * merged, whichever wrote last deleted the rest.
   */
  it("merges metadata instead of replacing it", () => {
    const base = {
      id: "ses_meta",
      workspaceId: "ws_meta",
      providerSessionId: "ses_meta",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat" as const,
      lastActivity: new Date().toISOString(),
    };
    upsertSession({ ...base, metadata: { firstPrompt: "review the PR" } });
    upsertSession({ ...base, metadata: { blockedSince: "2026-08-15T20:00:00.000Z" } });

    // A reconciler pass, which only ever knows what it read off disk.
    upsertSession({ ...base, metadata: { firstPrompt: "review the PR", messageCount: 12 } });

    const metadata = getStoredSession("ses_meta")?.metadata;
    expect(metadata?.blockedSince).toBe("2026-08-15T20:00:00.000Z");
    expect(metadata?.messageCount).toBe(12);
    expect(metadata?.firstPrompt).toBe("review the PR");
  });

  it("clears a metadata key when given an explicit null", () => {
    const base = {
      id: "ses_clear_meta",
      workspaceId: "ws_clear_meta",
      providerSessionId: "ses_clear_meta",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat" as const,
      lastActivity: new Date().toISOString(),
    };
    upsertSession({ ...base, metadata: { blockedSince: "2026-08-15T20:00:00.000Z" } });
    upsertSession({ ...base, metadata: { blockedSince: null } });
    expect(getStoredSession("ses_clear_meta")?.metadata?.blockedSince).toBeUndefined();
  });

  it("defaults a brand-new session to idle", () => {
    upsertSession({
      id: "ses_fresh",
      workspaceId: "ws_fresh",
      providerSessionId: "ses_fresh",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
      lastActivity: new Date().toISOString(),
    });
    expect(getStoredSession("ses_fresh")?.runtimeStatus).toBe("idle");
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

    // The git-status collector runs after `turn_stop`, asynchronously, and
    // shells out to `gh` — so it can land seconds late. It used to write
    // `completed` on the way past, which silently overwrote the `running` of a
    // turn started in that gap, with no event to correct it. The row read
    // "done" while the agent was mid-sentence, which is exactly the symptom
    // that made the active pane's spinner untrustworthy.
    it("merges metadata without asserting a runtime status", () => {
      seed("ses_metadata_only");
      touchSession("ses_metadata_only", "completed");
      updateSessionMetadata("ses_metadata_only", { gitStatus: { branch: "main" } });
      touchSession("ses_metadata_only", "running");

      expect(updateSessionMetadata("ses_metadata_only", { lastUserMessageAt: "2026-08-20" })).toBe(
        true,
      );
      const stored = getStoredSession("ses_metadata_only");
      expect(stored?.runtimeStatus).toBe("running");
      expect(stored?.metadata?.gitStatus).toEqual({ branch: "main" });
      expect(stored?.metadata?.lastUserMessageAt).toBe("2026-08-20");
    });

    it("reports nothing for a session it has no row for", () => {
      expect(updateSessionMetadata("ses_absent", { anything: true })).toBe(false);
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
    // Nothing is hidden from the tree. `archived` used to be, which made the
    // disposition that reads as "file this away" behave as a soft delete —
    // findable only by search. Sessions are never really deleted here and the
    // sidebar shouldn't imply otherwise; the queue is the thing that needs
    // decluttering, and both dispositions leave it.
    // Same rule as the work queue, so the two lists in the nav never disagree
    // about where a session lives. Recency ordering rearranged a folder every
    // time an unrelated session finished a turn — the row you reached for was
    // no longer the row under the cursor.
    it("orders the tree by creation, not by recent activity", () => {
      seed("ses_tree_old");
      seed("ses_tree_new");
      getSessionDb()
        .query("UPDATE sessions SET created_at = ? WHERE provider_session_id = ?")
        .run("2026-08-01T00:00:00.000Z", "ses_tree_old");
      getSessionDb()
        .query("UPDATE sessions SET created_at = ? WHERE provider_session_id = ?")
        .run("2026-08-12T00:00:00.000Z", "ses_tree_new");
      // The older session is the busy one. Under the old rule it led the list.
      touchSession("ses_tree_old", "running");

      const seeded = new Set(["ses_tree_old", "ses_tree_new"]);
      const ids = listWorkspaceSessions("ws_status")
        .map((s) => s.sessionId)
        .filter((id) => seeded.has(id));
      expect(ids).toEqual(["ses_tree_new", "ses_tree_old"]);
    });

    it("keeps resolved and archived sessions browsable in the tree", () => {
      seed("ses_open");
      seed("ses_resolved");
      seed("ses_archived");
      setSessionDisposition("ses_resolved", "resolved");
      setSessionDisposition("ses_archived", "archived");

      const visible = listWorkspaceSessions("ws_status").map((s) => s.sessionId);
      expect(visible).toContain("ses_open");
      expect(visible).toContain("ses_resolved");
      expect(visible).toContain("ses_archived");

      // Both are still out of the work queue, which is the point of setting
      // either one.
      const queued = listAttentionSessions({ now: "2026-08-15T12:00:00.000Z" }).map(
        (s) => s.sessionId,
      );
      expect(queued).not.toContain("ses_resolved");
      expect(queued).not.toContain("ses_archived");

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

      /** Backdate a row, since every seed in a test lands on the same second. */
      const createdAt = (id: string, iso: string) =>
        getSessionDb()
          .query("UPDATE sessions SET created_at = ? WHERE provider_session_id = ?")
          .run(iso, id);

      // Ordering by last activity meant the list rearranged itself under the
      // cursor: a row being read moved because some *other* session finished a
      // turn. Creation order never changes, so a given session is always found
      // in the same place — which is what makes a list scannable.
      it("orders by when a session was created, newest first", () => {
        seed("ses_oldest");
        seed("ses_middle");
        seed("ses_newest");
        createdAt("ses_oldest", "2026-08-01T00:00:00.000Z");
        createdAt("ses_middle", "2026-08-10T00:00:00.000Z");
        createdAt("ses_newest", "2026-08-14T00:00:00.000Z");

        // The busiest session is the oldest one — under the old rule it would
        // have led the list.
        touchSession("ses_oldest", "running");

        const seeded = new Set(["ses_oldest", "ses_middle", "ses_newest"]);
        const ids = listAttentionSessions({ now: NOW })
          .map((s) => s.sessionId)
          .filter((id) => seeded.has(id));
        expect(ids).toEqual(["ses_newest", "ses_middle", "ses_oldest"]);
      });

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

      // The queue used to force-include whatever session the tab had open, so
      // that reopening resolved work still gave you a row to act on. In use
      // that made the list rearrange itself as you clicked through it — a row
      // appearing from nowhere pushes every row below it down. Resolved work
      // belongs in the workspace tree, where it's highlighted when current and
      // its row menu offers the same actions.
      it("leaves a resolved session out, even the one the tab has open", () => {
        seed("ses_reopened");
        touchSession("ses_reopened", "completed");
        setSessionDisposition("ses_reopened", "resolved");

        expect(listAttentionSessions({ now: NOW }).map((s) => s.sessionId)).not.toContain(
          "ses_reopened",
        );
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
