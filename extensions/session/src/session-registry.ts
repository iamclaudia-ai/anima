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
      const runtimeStatus: RuntimeStatus = session.isProcessRunning
        ? session.stale
          ? "stalled"
          : "running"
        : "idle";

      upsertSession({
        id: session.id,
        workspaceId: workspaceResult.workspace.id,
        providerSessionId: session.id,
        model: session.model,
        agent: "claude",
        purpose: "chat",
        runtimeStatus,
        lastActivity: session.lastActivity,
      });

      if (session.isActive) {
        setWorkspaceActiveSession(workspaceResult.workspace.id, session.id);
      }
    }
  }
}
