import { createLogger, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  getStoredSession,
  getWorkspaceActiveSession,
  setWorkspaceActiveSession,
  upsertSession,
} from "../session-store";
import { getOrCreateWorkspace } from "../workspace";
import type { AgentHostSessionInfo, SessionRuntimeConfig } from "../session-types";

const log = createLogger("SessionExt:Activation", join(homedir(), ".anima", "logs", "session.log"));

interface SessionActivationDeps {
  sessionConfig: SessionRuntimeConfig;
  transitionConversation: (cwd: string) => Promise<void>;
  agentClient: {
    list(): Promise<unknown>;
    close(sessionId: string): Promise<void>;
    prompt(sessionId: string, content: string, cwd: string, model?: string): Promise<void>;
    createSession(params: { cwd: string; model: string }): Promise<{ sessionId: string }>;
  };
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
  agentClient: SessionActivationDeps["agentClient"];
}): Promise<void> {
  const activeSessions = (await params.agentClient.list()) as AgentHostSessionInfo[];
  const activeSession = activeSessions.find((session) => session.id === params.sessionId);
  if (
    activeSession &&
    activeSession.isProcessRunning &&
    activeSession.model &&
    activeSession.model !== params.desiredModel
  ) {
    log.warn("Detected model drift during switch; recycling session runtime", {
      sessionId: shortId(params.sessionId),
      runningModel: activeSession.model,
      desiredModel: params.desiredModel,
    });
    await params.agentClient.close(params.sessionId);
  }
}

export function createSessionActivationRunner(
  deps: SessionActivationDeps,
): SessionActivationRunner {
  return {
    switchSession: async (params) => {
      const workspaceResult = getOrCreateWorkspace(params.cwd);
      const existing = getStoredSession(params.sessionId);
      await deps.transitionConversation(params.cwd);

      const resumeModel = params.model || existing?.model || deps.sessionConfig.model;
      await recycleForModelDrift({
        sessionId: params.sessionId,
        desiredModel: resumeModel,
        agentClient: deps.agentClient,
      });

      log.info("Switching session", {
        sessionId: shortId(params.sessionId),
        cwd: params.cwd,
        model: resumeModel,
      });
      await deps.agentClient.prompt(params.sessionId, "", params.cwd, resumeModel);
      upsertSession({
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
      setWorkspaceActiveSession(workspaceResult.workspace.id, params.sessionId);
      return { sessionId: params.sessionId };
    },

    resetSession: async (params) => {
      const model = params.model || deps.sessionConfig.model;
      const workspaceResult = getOrCreateWorkspace(params.cwd);
      const previousSessionId = getWorkspaceActiveSession(workspaceResult.workspace.id);
      await deps.transitionConversation(params.cwd);

      log.info("Resetting session", { cwd: params.cwd });
      const result = await deps.agentClient.createSession({
        cwd: params.cwd,
        model,
      });
      upsertSession({
        id: result.sessionId,
        workspaceId: workspaceResult.workspace.id,
        providerSessionId: result.sessionId,
        model,
        agent: "claude",
        purpose: "chat",
        runtimeStatus: "idle",
        previousSessionId,
      });
      setWorkspaceActiveSession(workspaceResult.workspace.id, result.sessionId);
      return result;
    },
  };
}
