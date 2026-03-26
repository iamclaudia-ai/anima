import { createLogger, PERSISTENT_SESSION_ID, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  getStoredSession,
  setWorkspaceActiveSession,
  touchSession,
  upsertSession,
} from "../session-store";
import { getWorkspace, getOrCreateWorkspace } from "../workspace";
import { resolveSessionPath } from "../parse-session";
import {
  type AgentHostSessionInfo,
  type RequestContext,
  type SessionRuntimeConfig,
  summarizePrompt,
} from "../session-types";

const log = createLogger("SessionExt:Prompt", join(homedir(), ".anima", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

type SessionEventListener = (event: {
  sessionId: string;
  type?: string;
  eventName?: string;
}) => void;

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

// ── Dependencies ─────────────────────────────────────────────

interface PromptLifecycleDeps {
  sessionConfig: SessionRuntimeConfig;
  requestContexts: Map<string, RequestContext>;
  primaryContexts: Map<string, RequestContext>;
  resolvePersistentSession: (cwd: string) => Promise<string>;
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
  agentClient: {
    list(): Promise<unknown>;
    close(sessionId: string): Promise<void>;
    prompt(
      sessionId: string,
      content: string | unknown[],
      cwd: string | undefined,
      model: string,
      agent?: string,
    ): Promise<void>;
    on(event: "session.event", listener: SessionEventListener): void;
    removeListener(event: "session.event", listener: SessionEventListener): void;
  };
}

export interface PromptLifecycleRunner {
  run: (
    input: PromptLifecycleInput,
    request: { connectionId: string | null; tags: string[] | null },
  ) => Promise<{ status: "streaming"; sessionId: string } | { text: string; sessionId: string }>;
}

// ── Internal state ───────────────────────────────────────────

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

// ── Pipeline stages ──────────────────────────────────────────

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
  if (sessionId === PERSISTENT_SESSION_ID) {
    if (!input.cwd) throw new Error("cwd is required for persistent sessions");
    sessionId = await deps.resolvePersistentSession(input.cwd);
    log.info("Resolved persistent session", {
      cwd: input.cwd,
      sessionId: shortId(sessionId),
    });
  }

  log.info("Sending prompt", {
    agent: input.agent,
    sessionId: shortId(sessionId),
    streaming: input.streaming,
    source: input.source || "web",
    content: summarizePrompt(input.content),
  });

  const existing = getStoredSession(sessionId);
  let effectiveCwd = input.cwd;
  let workspaceResult = effectiveCwd !== undefined ? getOrCreateWorkspace(effectiveCwd) : undefined;
  if (!effectiveCwd && existing) {
    const storedWorkspace = getWorkspace(existing.workspaceId);
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
  const activeSessions = (await deps.agentClient.list()) as AgentHostSessionInfo[];
  const activeSession = activeSessions.find((session) => session.id === state.sessionId);
  if (
    activeSession &&
    activeSession.isProcessRunning &&
    activeSession.model &&
    activeSession.model !== state.resolvedModel
  ) {
    log.warn("Detected model drift; recycling session runtime", {
      sessionId: shortId(state.sessionId),
      runningModel: activeSession.model,
      desiredModel: state.resolvedModel,
    });
    await deps.agentClient.close(state.sessionId);
  }

  if (!state.existing && state.effectiveCwd && state.workspaceResult) {
    upsertSession({
      id: state.sessionId,
      workspaceId: state.workspaceResult.workspace.id,
      providerSessionId: state.sessionId,
      model: state.resolvedModel,
      agent: state.agent,
      purpose: "chat",
      runtimeStatus: "idle",
    });
    setWorkspaceActiveSession(state.workspaceResult.workspace.id, state.sessionId);
    return;
  }

  if (state.existing) {
    touchSession(state.sessionId);
  }
}

async function bootstrapSessionStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
): Promise<void> {
  if (!state.effectiveCwd || !state.workspaceResult) return;
  if (resolveSessionPath(state.sessionId, state.effectiveCwd)) return;

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

function attachRequestContextStage(
  state: PromptLifecycleState,
  deps: PromptLifecycleDeps,
  request: { connectionId: string | null; tags: string[] | null },
): void {
  const requestContext: RequestContext = {
    connectionId: request.connectionId,
    tags: request.tags,
    source: state.source,
    responseText: "",
  };
  const existingPrimary = deps.primaryContexts.get(state.sessionId);
  if (state.streaming && request.tags?.length) {
    deps.primaryContexts.set(state.sessionId, requestContext);
  } else if (existingPrimary && existingPrimary.connectionId !== request.connectionId) {
    log.info("Preserving primary context", {
      sessionId: shortId(state.sessionId),
      primaryConn: existingPrimary.connectionId?.slice(0, 8),
      transientConn: request.connectionId?.slice(0, 8),
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
  await deps.agentClient.prompt(
    state.sessionId,
    state.content,
    state.effectiveCwd,
    state.resolvedModel,
    state.agent,
  );

  const turnListener: SessionEventListener = (event) => {
    if (event.sessionId !== state.sessionId || event.type !== "turn_stop") return;
    const elapsed = Date.now() - promptStart;
    const reqCtx = deps.requestContexts.get(state.sessionId);
    const responseLen = reqCtx?.responseText?.length || 0;
    log.info("Streaming turn complete", {
      sessionId: shortId(state.sessionId),
      elapsed: `${elapsed}ms`,
      responseChars: responseLen,
    });
    deps.agentClient.removeListener("session.event", turnListener);
  };

  deps.agentClient.on("session.event", turnListener);
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
      log.error("Prompt timed out", {
        sessionId: shortId(state.sessionId),
        elapsed: "300s",
      });
      reject(new Error("Prompt timed out after 5 minutes"));
    }, 300_000);

    const onEvent: SessionEventListener = (event) => {
      if (event.sessionId !== state.sessionId) return;
      if (event.type === "turn_stop") {
        const reqCtx = deps.requestContexts.get(state.sessionId);
        const text = reqCtx?.responseText || "";
        cleanup();
        const elapsed = Date.now() - promptStart;
        log.info("Non-streaming prompt complete", {
          sessionId: shortId(state.sessionId),
          elapsed: `${elapsed}ms`,
          responseChars: text.length,
        });
        resolve({ text, sessionId: state.sessionId });
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      deps.agentClient.removeListener("session.event", onEvent);
      deps.requestContexts.delete(state.sessionId);
      deps.primaryContexts.delete(state.sessionId);
    };

    deps.agentClient.on("session.event", onEvent);
    deps.agentClient
      .prompt(state.sessionId, state.content, state.effectiveCwd, state.resolvedModel, state.agent)
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

// ── Factory ──────────────────────────────────────────────────

export function createPromptLifecycleRunner(deps: PromptLifecycleDeps): PromptLifecycleRunner {
  return {
    run: async (input, request) => {
      const state = await resolveSessionStage(input, deps);
      await prepareRuntimeStage(state, deps);
      await bootstrapSessionStage(state, deps);
      attachRequestContextStage(state, deps, request);
      if (state.streaming) {
        return await dispatchStreamingPromptStage(state, deps);
      }
      return await dispatchNonStreamingPromptStage(state, deps);
    },
  };
}
