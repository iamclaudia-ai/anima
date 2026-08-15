import type { AgentHostSessionInfo } from "./session-types";
import {
  getStoredSession,
  setWorkspaceActiveSession,
  upsertSession,
  type StoredSession,
  type RuntimeStatus,
} from "./session-store";
import {
  deleteWorkspace,
  getOrCreateWorkspace,
  getWorkspace,
  getWorkspaceByCwd,
  listWorkspaces,
  setWorkspacePinned,
} from "./workspace";

export class SessionRegistry {
  getOrCreateWorkspace(cwd: string, name?: string, general?: boolean) {
    return getOrCreateWorkspace(cwd, name, general);
  }

  getWorkspace(id: string) {
    return getWorkspace(id);
  }

  getWorkspaceByCwd(cwd: string) {
    return getWorkspaceByCwd(cwd);
  }

  listWorkspaces() {
    return listWorkspaces();
  }

  deleteWorkspace(cwd: string): boolean {
    return deleteWorkspace(cwd);
  }

  setWorkspacePinned(id: string, pinned: boolean) {
    return setWorkspacePinned(id, pinned);
  }

  getStoredSession(id: string): StoredSession | null {
    return getStoredSession(id);
  }

  setWorkspaceActiveSession(workspaceId: string, sessionId: string): void {
    setWorkspaceActiveSession(workspaceId, sessionId);
  }

  upsertSession(params: Parameters<typeof upsertSession>[0]): void {
    upsertSession(params);
  }

  archiveSession(sessionId: string): void {
    const existing = getStoredSession(sessionId);
    if (!existing) return;

    upsertSession({
      id: existing.id,
      workspaceId: existing.workspaceId,
      providerSessionId: existing.providerSessionId,
      model: existing.model,
      agent: existing.agent,
      purpose: existing.purpose,
      parentSessionId: existing.parentSessionId,
      status: "archived",
      runtimeStatus: existing.runtimeStatus,
      title: existing.title,
      summary: existing.summary,
      metadata: existing.metadata,
      previousSessionId: existing.previousSessionId,
    });
  }

  recordConnectedSessions(sessions: AgentHostSessionInfo[]): void {
    for (const session of sessions) {
      if (!session.cwd) continue;
      const workspaceResult = getOrCreateWorkspace(session.cwd);
      // A live process is not a turn in flight. `isProcessRunning` is true for
      // every attached CLI pane, so mapping it to `running` marked six live
      // sessions permanently busy — and a dot that is always green trains you
      // to ignore the one that matters. `running` is written by the prompt
      // lifecycle, which is the only place that knows a turn actually started.
      // `undefined` rather than `idle` for the healthy case: this sweep knows a
      // process exists, which is not the same as knowing what it's doing. The
      // lifecycle owns that, and asserting `idle` here overwrote it — a session
      // waiting on a modal prompt was reset on the next reconnect.
      const runtimeStatus: RuntimeStatus | undefined =
        session.isProcessRunning && session.stale ? "stalled" : undefined;

      // Adoption is not activity. Agent-host reports `lastActivity` as the
      // moment it noticed the pane, so readopting on every reconnect was
      // stamping live sessions with "now" — which reordered the nav on a
      // restart and reset the clock behind "this finished 20 minutes ago and
      // you haven't looked". A session's last activity is the last thing said
      // in it, so an existing row keeps the value it already had.
      const existing = getStoredSession(session.id);

      upsertSession({
        id: session.id,
        workspaceId: workspaceResult.workspace.id,
        providerSessionId: session.id,
        model: session.model,
        agent: "claude",
        purpose: "chat",
        runtimeStatus,
        lastActivity: existing?.lastActivity ?? session.lastActivity,
      });

      if (session.isActive) {
        setWorkspaceActiveSession(workspaceResult.workspace.id, session.id);
      }
    }
  }
}
