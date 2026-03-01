import type { SessionInfo, WorkspaceInfo } from "@claudia/ui";

export type GatewayCaller = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface MainPageBootstrapResult {
  workspaces: WorkspaceInfo[];
  activeWorkspace: WorkspaceInfo | null;
  sessions: SessionInfo[];
  activeSessionId: string | null;
}

export async function loadSessionsForWorkspace(
  callGateway: GatewayCaller,
  cwd: string,
): Promise<SessionInfo[]> {
  const payload = (await callGateway("session.list_sessions", { cwd })) as {
    sessions?: SessionInfo[];
  } | null;
  return payload?.sessions ?? [];
}

export async function createSessionForWorkspace(
  callGateway: GatewayCaller,
  cwd: string,
): Promise<string | null> {
  const payload = (await callGateway("session.create_session", { cwd })) as {
    sessionId?: string;
  } | null;
  return payload?.sessionId ?? null;
}

export async function loadMainPageBootstrapData(
  callGateway: GatewayCaller,
  options: {
    workspaceId?: string;
    sessionId?: string;
    hasActiveSession: boolean;
  },
): Promise<MainPageBootstrapResult> {
  const payload = (await callGateway("session.list_workspaces")) as {
    workspaces?: WorkspaceInfo[];
  } | null;
  const workspaces = payload?.workspaces ?? [];
  const activeWorkspace = options.workspaceId
    ? (workspaces.find((workspace) => workspace.id === options.workspaceId) ?? null)
    : (workspaces[0] ?? null);

  if (!activeWorkspace) {
    return {
      workspaces,
      activeWorkspace: null,
      sessions: [],
      activeSessionId: null,
    };
  }

  const sessions = await loadSessionsForWorkspace(callGateway, activeWorkspace.cwd);
  const activeSessionId =
    options.sessionId && !options.hasActiveSession
      ? (sessions.find((session) => session.sessionId === options.sessionId)?.sessionId ?? null)
      : null;

  return {
    workspaces,
    activeWorkspace,
    sessions,
    activeSessionId,
  };
}
