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

export interface PromptLifecycleSessionOps {
  persistentSessionId: string;
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

export interface PromptLifecycleRequestState {
  connectionId: string | null;
  tags: string[] | null;
  requestContexts: Map<string, RequestContext>;
  primaryContexts: Map<string, RequestContext>;
}

export interface PromptLifecycleServices {
  sessionConfig: SessionRuntimeConfigLike;
  log: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
  sid: (sessionId: string) => string;
  summarizePrompt: (content: string | unknown[]) => unknown;
}

export interface PromptLifecycleDeps {
  session: PromptLifecycleSessionOps;
  request: PromptLifecycleRequestState;
  services: PromptLifecycleServices;
}

export interface PromptLifecycleRunner {
  run: (
    input: PromptLifecycleInput,
    request: { connectionId: string | null; tags: string[] | null },
  ) => Promise<{ status: "streaming"; sessionId: string } | { text: string; sessionId: string }>;
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
        : deps.services.sessionConfig.thinking,
    effort:
      metadata?.bootstrapEffort === "low" ||
      metadata?.bootstrapEffort === "medium" ||
      metadata?.bootstrapEffort === "high" ||
      metadata?.bootstrapEffort === "max"
        ? metadata.bootstrapEffort
        : deps.services.sessionConfig.effort,
    baseSystemPrompt:
      typeof metadata?.bootstrapSystemPrompt === "string"
        ? metadata.bootstrapSystemPrompt
        : deps.services.sessionConfig.systemPrompt || undefined,
  };
}

async function resolveSessionStage(
  input: PromptLifecycleInput,
  deps: PromptLifecycleDeps,
): Promise<PromptLifecycleState> {
  let sessionId = input.sessionId;
  if (sessionId === deps.session.persistentSessionId) {
    if (!input.cwd) throw new Error("cwd is required for persistent sessions");
    sessionId = await deps.session.resolvePersistentSession(input.cwd);
    deps.services.log.info("Resolved persistent session", {
      cwd: input.cwd,
      sessionId: deps.services.sid(sessionId),
    });
  }

  deps.services.log.info("Sending prompt", {
    agent: input.agent,
    sessionId: deps.services.sid(sessionId),
    streaming: input.streaming,
    source: input.source || "web",
    content: deps.services.summarizePrompt(input.content),
  });

  const existing = deps.session.getStoredSession(sessionId);
  let effectiveCwd = input.cwd;
  let workspaceResult =
    effectiveCwd !== undefined ? deps.session.getOrCreateWorkspace(effectiveCwd) : undefined;
  if (!effectiveCwd && existing) {
    const storedWorkspace = deps.session.getWorkspace(existing.workspaceId);
    if (storedWorkspace) {
      effectiveCwd = storedWorkspace.cwd;
      workspaceResult = { workspace: storedWorkspace, created: false };
    }
  }

  return {
    sessionId,
    content: input.content,
    effectiveCwd,
    resolvedModel: input.model || existing?.model || deps.services.sessionConfig.model,
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
  const activeSessions = await deps.session.listActiveSessions();
  const activeSession = activeSessions.find((session) => session.id === state.sessionId);
  if (
    activeSession &&
    activeSession.isProcessRunning &&
    activeSession.model &&
    activeSession.model !== state.resolvedModel
  ) {
    deps.services.log.warn("Detected model drift; recycling session runtime", {
      sessionId: deps.services.sid(state.sessionId),
      runningModel: activeSession.model,
      desiredModel: state.resolvedModel,
    });
    await deps.session.closeSession(state.sessionId);
  }

  if (!state.existing && state.effectiveCwd && state.workspaceResult) {
    deps.session.upsertSession({
      id: state.sessionId,
      workspaceId: state.workspaceResult.workspace.id,
      providerSessionId: state.sessionId,
      model: state.resolvedModel,
      agent: state.agent,
      purpose: "chat",
      runtimeStatus: "idle",
    });
    deps.session.setWorkspaceActiveSession(state.workspaceResult.workspace.id, state.sessionId);
    return;
  }

  if (state.existing) {
    deps.session.touchSession(state.sessionId);
  }
}

async function bootstrapSessionStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): Promise<void> {
  if (!state.effectiveCwd || !state.workspaceResult) return;
  if (deps.session.resolveSessionPath(state.sessionId, state.effectiveCwd)) return;

  const bootstrap = getBootstrapSettings(state, deps);
  await deps.session.ensureSessionBootstrapped({
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
    connectionId: deps.request.connectionId,
    tags: deps.request.tags,
    source: state.source,
    responseText: "",
  };
  const existingPrimary = deps.request.primaryContexts.get(state.sessionId);
  if (state.streaming && deps.request.tags?.length) {
    deps.request.primaryContexts.set(state.sessionId, requestContext);
  } else if (existingPrimary && existingPrimary.connectionId !== deps.request.connectionId) {
    deps.services.log.info("Preserving primary context", {
      sessionId: deps.services.sid(state.sessionId),
      primaryConn: existingPrimary.connectionId?.slice(0, 8),
      transientConn: deps.request.connectionId?.slice(0, 8),
    });
  }

  deps.request.requestContexts.set(state.sessionId, requestContext);
  state.requestContext = requestContext;
}

async function dispatchStreamingPromptStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): Promise<{ status: "streaming"; sessionId: string }> {
  const promptStart = Date.now();
  await deps.session.promptSession(
    state.sessionId,
    state.content,
    state.effectiveCwd,
    state.resolvedModel,
    state.agent,
  );

  const turnListener = (event: { sessionId: string; type?: string }) => {
    if (event.sessionId !== state.sessionId || event.type !== "turn_stop") return;
    const elapsed = Date.now() - promptStart;
    const reqCtx = deps.request.requestContexts.get(state.sessionId);
    const responseLen = reqCtx?.responseText?.length || 0;
    deps.services.log.info("Streaming turn complete", {
      sessionId: deps.services.sid(state.sessionId),
      elapsed: `${elapsed}ms`,
      responseChars: responseLen,
    });
    deps.session.removeSessionEventListener(turnListener);
  };

  deps.session.onSessionEvent(turnListener);
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
      deps.services.log.error("Prompt timed out", {
        sessionId: deps.services.sid(state.sessionId),
        elapsed: "300s",
      });
      reject(new Error("Prompt timed out after 5 minutes"));
    }, 300_000);

    const onEvent = (event: { sessionId: string; type?: string }) => {
      if (event.sessionId !== state.sessionId) return;
      if (event.type === "turn_stop") {
        const reqCtx = deps.request.requestContexts.get(state.sessionId);
        const text = reqCtx?.responseText || "";
        cleanup();
        const elapsed = Date.now() - promptStart;
        deps.services.log.info("Non-streaming prompt complete", {
          sessionId: deps.services.sid(state.sessionId),
          elapsed: `${elapsed}ms`,
          responseChars: text.length,
        });
        resolve({ text, sessionId: state.sessionId });
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      deps.session.removeSessionEventListener(onEvent);
      deps.request.requestContexts.delete(state.sessionId);
      deps.request.primaryContexts.delete(state.sessionId);
    };

    deps.session.onSessionEvent(onEvent);
    deps.session
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

export function createPromptLifecycleRunner(base: {
  session: PromptLifecycleSessionOps;
  requestState: {
    requestContexts: Map<string, RequestContext>;
    primaryContexts: Map<string, RequestContext>;
  };
  services: PromptLifecycleServices;
}): PromptLifecycleRunner {
  return {
    run: async (
      input: PromptLifecycleInput,
      request: { connectionId: string | null; tags: string[] | null },
    ) => {
      const deps: PromptLifecycleDeps = {
        session: base.session,
        request: {
          connectionId: request.connectionId,
          tags: request.tags,
          requestContexts: base.requestState.requestContexts,
          primaryContexts: base.requestState.primaryContexts,
        },
        services: base.services,
      };

      const state = await resolveSessionStage(input, deps);
      await prepareRuntimeStage(state, deps);
      await bootstrapSessionStage(state, deps);
      attachRequestContextStage(state, deps);
      if (state.streaming) {
        return await dispatchStreamingPromptStage(state, deps);
      }
      return await dispatchNonStreamingPromptStage(state, deps);
    },
  };
}
