interface StoredSessionLike {
  id: string;
  workspaceId: string;
  providerSessionId: string;
  model: string;
  agent: string;
  purpose: "chat" | "task" | "review" | "test";
  runtimeStatus: "idle" | "running" | "completed" | "failed" | "interrupted" | "stalled";
  metadata: Record<string, unknown> | null;
  previousSessionId: string | null;
}

interface WorkspaceInfoLike {
  id: string;
}

interface WorkspaceResultLike {
  workspace: WorkspaceInfoLike;
  created: boolean;
}

interface AgentHostSessionInfoLike {
  id: string;
  model?: string;
  isProcessRunning: boolean;
}

interface SessionRuntimeConfigLike {
  model: string;
}

interface SessionActivationLog {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
}

interface SessionActivationDeps {
  sessionConfig: SessionRuntimeConfigLike;
  log: SessionActivationLog;
  sid: (sessionId: string) => string;
  transitionConversation: (cwd: string) => Promise<void>;
  getStoredSession: (sessionId: string) => StoredSessionLike | null;
  getOrCreateWorkspace: (cwd: string) => WorkspaceResultLike;
  getWorkspaceActiveSession: (workspaceId: string) => string | null;
  setWorkspaceActiveSession: (workspaceId: string, sessionId: string) => void;
  upsertSession: (params: {
    id: string;
    workspaceId: string;
    providerSessionId?: string;
    model?: string;
    agent?: string;
    purpose?: "chat" | "task" | "review" | "test";
    runtimeStatus?: "idle" | "running" | "completed" | "failed" | "interrupted" | "stalled";
    metadata?: Record<string, unknown> | null;
    previousSessionId?: string | null;
  }) => void;
  listActiveSessions: () => Promise<AgentHostSessionInfoLike[]>;
  closeSession: (sessionId: string) => Promise<void>;
  promptSession: (sessionId: string, content: string, cwd: string, model?: string) => Promise<void>;
  createSession: (params: { cwd: string; model: string }) => Promise<{ sessionId: string }>;
}

export interface SessionActivationRunner {
  switchSession: (params: {
    sessionId: string;
    cwd: string;
    model?: string;
  }) => Promise<{ sessionId: string }>;
  resetSession: (params: { cwd: string; model?: string }) => Promise<{ sessionId: string }>;
}

async function recycleForModelDrift(params: {
  sessionId: string;
  desiredModel: string;
  listActiveSessions: () => Promise<AgentHostSessionInfoLike[]>;
  closeSession: (sessionId: string) => Promise<void>;
  log: SessionActivationLog;
  sid: (sessionId: string) => string;
}): Promise<void> {
  const activeSessions = await params.listActiveSessions();
  const activeSession = activeSessions.find((session) => session.id === params.sessionId);
  if (
    activeSession &&
    activeSession.isProcessRunning &&
    activeSession.model &&
    activeSession.model !== params.desiredModel
  ) {
    params.log.warn("Detected model drift during switch; recycling session runtime", {
      sessionId: params.sid(params.sessionId),
      runningModel: activeSession.model,
      desiredModel: params.desiredModel,
    });
    await params.closeSession(params.sessionId);
  }
}

export function createSessionActivationRunner(
  deps: SessionActivationDeps,
): SessionActivationRunner {
  return {
    switchSession: async (params) => {
      const workspaceResult = deps.getOrCreateWorkspace(params.cwd);
      const existing = deps.getStoredSession(params.sessionId);
      await deps.transitionConversation(params.cwd);

      const resumeModel = params.model || existing?.model || deps.sessionConfig.model;
      await recycleForModelDrift({
        sessionId: params.sessionId,
        desiredModel: resumeModel,
        listActiveSessions: deps.listActiveSessions,
        closeSession: deps.closeSession,
        log: deps.log,
        sid: deps.sid,
      });

      deps.log.info("Switching session", {
        sessionId: deps.sid(params.sessionId),
        cwd: params.cwd,
        model: resumeModel,
      });
      await deps.promptSession(params.sessionId, "", params.cwd, resumeModel);
      deps.upsertSession({
        id: params.sessionId,
        workspaceId: workspaceResult.workspace.id,
        providerSessionId: existing?.providerSessionId || params.sessionId,
        model: existing?.model || resumeModel,
        agent: existing?.agent || "claude",
        purpose: existing?.purpose || "chat",
        runtimeStatus: "idle",
        metadata: existing?.metadata || null,
        previousSessionId: existing?.previousSessionId ?? null,
      });
      deps.setWorkspaceActiveSession(workspaceResult.workspace.id, params.sessionId);
      return { sessionId: params.sessionId };
    },

    resetSession: async (params) => {
      const model = params.model || deps.sessionConfig.model;
      const workspaceResult = deps.getOrCreateWorkspace(params.cwd);
      const previousSessionId = deps.getWorkspaceActiveSession(workspaceResult.workspace.id);
      await deps.transitionConversation(params.cwd);

      deps.log.info("Resetting session", { cwd: params.cwd });
      const result = await deps.createSession({
        cwd: params.cwd,
        model,
      });
      deps.upsertSession({
        id: result.sessionId,
        workspaceId: workspaceResult.workspace.id,
        providerSessionId: result.sessionId,
        model,
        agent: "claude",
        purpose: "chat",
        runtimeStatus: "idle",
        previousSessionId,
      });
      deps.setWorkspaceActiveSession(workspaceResult.workspace.id, result.sessionId);
      return result;
    },
  };
}
