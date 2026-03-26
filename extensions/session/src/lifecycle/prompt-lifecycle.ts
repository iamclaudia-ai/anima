interface RequestContext {
  connectionId: string | null;
  tags: string[] | null;
  source?: string;
  responseText: string;
}

interface StoredSessionLike {
  workspaceId: string;
  model: string;
  metadata: Record<string, unknown> | null;
}

interface WorkspaceInfoLike {
  id: string;
  cwd: string;
  general: boolean;
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
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  systemPrompt: string | null;
}

interface SessionBootstrapMetadata {
  bootstrapSystemPrompt?: string;
  bootstrapThinking?: boolean;
  bootstrapEffort?: "low" | "medium" | "high" | "max";
}

export interface PromptLifecycleInput {
  sessionId: string;
  content: string | unknown[];
  cwd?: string;
  model?: string;
  agent: string;
  streaming: boolean;
  source?: string;
}

export interface PromptLifecycleDeps {
  persistentSessionId: string;
  connectionId: string | null;
  tags: string[] | null;
  sessionConfig: SessionRuntimeConfigLike;
  requestContexts: Map<string, RequestContext>;
  primaryContexts: Map<string, RequestContext>;
  log: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
  sid: (sessionId: string) => string;
  summarizePrompt: (content: string | unknown[]) => unknown;
  resolvePersistentSession: (cwd: string) => Promise<string>;
  getStoredSession: (sessionId: string) => StoredSessionLike | null;
  getWorkspace: (id: string) => WorkspaceInfoLike | null;
  getOrCreateWorkspace: (cwd: string) => WorkspaceResultLike;
  setWorkspaceActiveSession: (workspaceId: string, sessionId: string) => void;
  touchSession: (sessionId: string) => void;
  upsertSession: (params: {
    id: string;
    workspaceId: string;
    providerSessionId: string;
    model: string;
    agent: string;
    purpose: "chat";
    runtimeStatus: "idle";
  }) => void;
  resolveSessionPath: (sessionId: string, cwd?: string) => string | null;
  ensureSessionBootstrapped: (params: {
    sessionId: string;
    cwd: string;
    workspaceId: string;
    agent: string;
    model: string;
    thinking: boolean;
    effort: "low" | "medium" | "high" | "max";
    baseSystemPrompt?: string;
    includeAllSummaries: boolean;
  }) => Promise<void>;
  listActiveSessions: () => Promise<AgentHostSessionInfoLike[]>;
  closeSession: (sessionId: string) => Promise<void>;
  promptSession: (
    sessionId: string,
    content: string | unknown[],
    cwd: string | undefined,
    model: string,
    agent: string,
  ) => Promise<void>;
  onSessionEvent: (
    listener: (event: { sessionId: string; type?: string; eventName?: string }) => void,
  ) => void;
  removeSessionEventListener: (
    listener: (event: { sessionId: string; type?: string; eventName?: string }) => void,
  ) => void;
}

interface PromptLifecycleState {
  sessionId: string;
  content: string | unknown[];
  effectiveCwd?: string;
  resolvedModel: string;
  agent: string;
  streaming: boolean;
  source?: string;
  existing: StoredSessionLike | null;
  existingMetadata: SessionBootstrapMetadata | null;
  workspaceResult?: WorkspaceResultLike;
  requestContext?: RequestContext;
}

function getBootstrapSettings(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): {
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  baseSystemPrompt?: string;
} {
  const metadata = state.existingMetadata;
  return {
    thinking:
      typeof metadata?.bootstrapThinking === "boolean"
        ? metadata.bootstrapThinking
        : deps.sessionConfig.thinking,
    effort:
      metadata?.bootstrapEffort === "low" ||
      metadata?.bootstrapEffort === "medium" ||
      metadata?.bootstrapEffort === "high" ||
      metadata?.bootstrapEffort === "max"
        ? metadata.bootstrapEffort
        : deps.sessionConfig.effort,
    baseSystemPrompt:
      typeof metadata?.bootstrapSystemPrompt === "string"
        ? metadata.bootstrapSystemPrompt
        : deps.sessionConfig.systemPrompt || undefined,
  };
}

async function resolveSessionStage(
  input: PromptLifecycleInput,
  deps: PromptLifecycleDeps,
): Promise<PromptLifecycleState> {
  let sessionId = input.sessionId;
  if (sessionId === deps.persistentSessionId) {
    if (!input.cwd) throw new Error("cwd is required for persistent sessions");
    sessionId = await deps.resolvePersistentSession(input.cwd);
    deps.log.info("Resolved persistent session", {
      cwd: input.cwd,
      sessionId: deps.sid(sessionId),
    });
  }

  deps.log.info("Sending prompt", {
    agent: input.agent,
    sessionId: deps.sid(sessionId),
    streaming: input.streaming,
    source: input.source || "web",
    content: deps.summarizePrompt(input.content),
  });

  const existing = deps.getStoredSession(sessionId);
  let effectiveCwd = input.cwd;
  let workspaceResult =
    effectiveCwd !== undefined ? deps.getOrCreateWorkspace(effectiveCwd) : undefined;
  if (!effectiveCwd && existing) {
    const storedWorkspace = deps.getWorkspace(existing.workspaceId);
    if (storedWorkspace) {
      effectiveCwd = storedWorkspace.cwd;
      workspaceResult = { workspace: storedWorkspace, created: false };
    }
  }

  return {
    sessionId,
    content: input.content,
    effectiveCwd,
    resolvedModel: input.model || existing?.model || deps.sessionConfig.model,
    agent: input.agent,
    streaming: input.streaming,
    source: input.source,
    existing,
    existingMetadata: (existing?.metadata || null) as SessionBootstrapMetadata | null,
    workspaceResult,
  };
}

async function prepareRuntimeStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): Promise<void> {
  const activeSessions = await deps.listActiveSessions();
  const activeSession = activeSessions.find((session) => session.id === state.sessionId);
  if (
    activeSession &&
    activeSession.isProcessRunning &&
    activeSession.model &&
    activeSession.model !== state.resolvedModel
  ) {
    deps.log.warn("Detected model drift; recycling session runtime", {
      sessionId: deps.sid(state.sessionId),
      runningModel: activeSession.model,
      desiredModel: state.resolvedModel,
    });
    await deps.closeSession(state.sessionId);
  }

  if (!state.existing && state.effectiveCwd && state.workspaceResult) {
    deps.upsertSession({
      id: state.sessionId,
      workspaceId: state.workspaceResult.workspace.id,
      providerSessionId: state.sessionId,
      model: state.resolvedModel,
      agent: state.agent,
      purpose: "chat",
      runtimeStatus: "idle",
    });
    deps.setWorkspaceActiveSession(state.workspaceResult.workspace.id, state.sessionId);
    return;
  }

  if (state.existing) {
    deps.touchSession(state.sessionId);
  }
}

async function bootstrapSessionStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): Promise<void> {
  if (!state.effectiveCwd || !state.workspaceResult) return;
  if (deps.resolveSessionPath(state.sessionId, state.effectiveCwd)) return;

  const bootstrap = getBootstrapSettings(state, deps);
  await deps.ensureSessionBootstrapped({
    sessionId: state.sessionId,
    cwd: state.effectiveCwd,
    workspaceId: state.workspaceResult.workspace.id,
    agent: state.agent,
    model: state.resolvedModel,
    thinking: bootstrap.thinking,
    effort: bootstrap.effort,
    baseSystemPrompt: bootstrap.baseSystemPrompt,
    includeAllSummaries: state.workspaceResult.workspace.general,
  });
}

function attachRequestContextStage(state: PromptLifecycleState, deps: PromptLifecycleDeps): void {
  const requestContext: RequestContext = {
    connectionId: deps.connectionId,
    tags: deps.tags,
    source: state.source,
    responseText: "",
  };
  const existingPrimary = deps.primaryContexts.get(state.sessionId);
  if (state.streaming && deps.tags?.length) {
    deps.primaryContexts.set(state.sessionId, requestContext);
  } else if (existingPrimary && existingPrimary.connectionId !== deps.connectionId) {
    deps.log.info("Preserving primary context", {
      sessionId: deps.sid(state.sessionId),
      primaryConn: existingPrimary.connectionId?.slice(0, 8),
      transientConn: deps.connectionId?.slice(0, 8),
    });
  }

  deps.requestContexts.set(state.sessionId, requestContext);
  state.requestContext = requestContext;
}

async function dispatchStreamingPromptStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): Promise<{ status: "streaming"; sessionId: string }> {
  const promptStart = Date.now();
  await deps.promptSession(
    state.sessionId,
    state.content,
    state.effectiveCwd,
    state.resolvedModel,
    state.agent,
  );

  const turnListener = (event: { sessionId: string; type?: string }) => {
    if (event.sessionId !== state.sessionId || event.type !== "turn_stop") return;
    const elapsed = Date.now() - promptStart;
    const reqCtx = deps.requestContexts.get(state.sessionId);
    const responseLen = reqCtx?.responseText?.length || 0;
    deps.log.info("Streaming turn complete", {
      sessionId: deps.sid(state.sessionId),
      elapsed: `${elapsed}ms`,
      responseChars: responseLen,
    });
    deps.removeSessionEventListener(turnListener);
  };

  deps.onSessionEvent(turnListener);
  return { status: "streaming", sessionId: state.sessionId };
}

async function dispatchNonStreamingPromptStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): Promise<{ text: string; sessionId: string }> {
  const promptStart = Date.now();
  return await new Promise<{ text: string; sessionId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      deps.log.error("Prompt timed out", { sessionId: deps.sid(state.sessionId), elapsed: "300s" });
      reject(new Error("Prompt timed out after 5 minutes"));
    }, 300_000);

    const onEvent = (event: { sessionId: string; type?: string }) => {
      if (event.sessionId !== state.sessionId) return;
      if (event.type === "turn_stop") {
        const reqCtx = deps.requestContexts.get(state.sessionId);
        const text = reqCtx?.responseText || "";
        cleanup();
        const elapsed = Date.now() - promptStart;
        deps.log.info("Non-streaming prompt complete", {
          sessionId: deps.sid(state.sessionId),
          elapsed: `${elapsed}ms`,
          responseChars: text.length,
        });
        resolve({ text, sessionId: state.sessionId });
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      deps.removeSessionEventListener(onEvent);
      deps.requestContexts.delete(state.sessionId);
      deps.primaryContexts.delete(state.sessionId);
    };

    deps.onSessionEvent(onEvent);
    deps
      .promptSession(
        state.sessionId,
        state.content,
        state.effectiveCwd,
        state.resolvedModel,
        state.agent,
      )
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

export async function runPromptLifecycle(
  input: PromptLifecycleInput,
  deps: PromptLifecycleDeps,
): Promise<{ status: "streaming"; sessionId: string } | { text: string; sessionId: string }> {
  const state = await resolveSessionStage(input, deps);
  await prepareRuntimeStage(state, deps);
  await bootstrapSessionStage(state, deps);
  attachRequestContextStage(state, deps);
  if (state.streaming) {
    return await dispatchStreamingPromptStage(state, deps);
  }
  return await dispatchNonStreamingPromptStage(state, deps);
}
