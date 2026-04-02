import { createLogger, shortId, withTimeout } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { getWorkspaceActiveSession } from "../session-store";
import type { AgentHostSessionInfo } from "../session-types";
import { getRuntime } from "../runtime";

const log = createLogger("SessionExt:Activation", join(homedir(), ".anima", "logs", "session.log"));

const MEMORY_TRANSITION_TIMEOUT_MS = 1500;

async function transitionConversation(cwd: string): Promise<void> {
  const rt = getRuntime();
  try {
    await withTimeout(
      rt.ctx.call("memory.transition_conversation", { cwd }),
      MEMORY_TRANSITION_TIMEOUT_MS,
      "memory.transition_conversation",
    );
  } catch (err) {
    log.warn("Failed to transition previous conversations (non-fatal)", {
      cwd,
      error: String(err),
    });
  }
}

async function recycleForModelDrift(sessionId: string, desiredModel: string): Promise<void> {
  const rt = getRuntime();
  const activeSessions = (await rt.bridge.listSessions()) as AgentHostSessionInfo[];
  const activeSession = activeSessions.find((s) => s.id === sessionId);
  if (
    activeSession &&
    activeSession.isProcessRunning &&
    activeSession.model &&
    activeSession.model !== desiredModel
  ) {
    log.warn("Detected model drift during switch; recycling session runtime", {
      sessionId: shortId(sessionId),
      runningModel: activeSession.model,
      desiredModel,
    });
    await rt.bridge.closeSession(sessionId);
  }
}

export async function switchSession(params: {
  sessionId: string;
  cwd: string;
  model?: string;
}): Promise<{ sessionId: string }> {
  const rt = getRuntime();
  const workspaceResult = rt.registry.getOrCreateWorkspace(params.cwd);
  const existing = rt.registry.getStoredSession(params.sessionId);
  await transitionConversation(params.cwd);

  const resumeModel = params.model || existing?.model || rt.sessionConfig.model;
  await recycleForModelDrift(params.sessionId, resumeModel);

  log.info("Switching session", {
    sessionId: shortId(params.sessionId),
    cwd: params.cwd,
    model: resumeModel,
  });
  await rt.bridge.prompt(params.sessionId, "", params.cwd, resumeModel);
  rt.registry.upsertSession({
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
  rt.registry.setWorkspaceActiveSession(workspaceResult.workspace.id, params.sessionId);
  return { sessionId: params.sessionId };
}

export async function resetSession(params: {
  cwd: string;
  model?: string;
}): Promise<{ sessionId: string }> {
  const rt = getRuntime();
  const model = params.model || rt.sessionConfig.model;
  const workspaceResult = rt.registry.getOrCreateWorkspace(params.cwd);
  const previousSessionId = getWorkspaceActiveSession(workspaceResult.workspace.id);
  await transitionConversation(params.cwd);

  log.info("Resetting session", { cwd: params.cwd });
  const result = await rt.bridge.createSession({ cwd: params.cwd, model });
  rt.registry.upsertSession({
    id: result.sessionId,
    workspaceId: workspaceResult.workspace.id,
    providerSessionId: result.sessionId,
    model,
    agent: "claude",
    purpose: "chat",
    runtimeStatus: "idle",
    previousSessionId,
  });
  rt.registry.setWorkspaceActiveSession(workspaceResult.workspace.id, result.sessionId);
  return result;
}
