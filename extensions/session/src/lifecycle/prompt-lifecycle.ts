import { createLogger, PERSISTENT_SESSION_ID, shortId, withTimeout } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { touchSession } from "../session-store";
import { resolveSessionPath } from "../parse-session";
import { formatMemoryContext, type MemoryContextResult } from "../memory-context";
import { type AgentHostSessionInfo, type RequestContext, summarizePrompt } from "../session-types";
import { resolvePersistentSessionForCwd } from "../persistent-sessions";
import { getRuntime } from "../runtime";

const log = createLogger("SessionExt:Prompt", join(homedir(), ".anima", "logs", "session.log"));

const MEMORY_TRANSITION_TIMEOUT_MS = 1500;
const MEMORY_CONTEXT_TIMEOUT_MS = 2000;

// ── Types ────────────────────────────────────────────────────

type SessionEventListener = (event: {
  sessionId: string;
  type?: string;
  eventName?: string;
}) => void;

interface StoredSessionLike {
  workspaceId: string;
  model: string;
  agent: string;
  purpose: "chat" | "subagent" | "review" | "test";
  parentSessionId: string | null;
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

// ── Helpers ─────────────────────────────────────────────────

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

async function resolvePersistentSession(cwd: string): Promise<string> {
  const rt = getRuntime();
  return resolvePersistentSessionForCwd({
    cwd,
    store: {
      getEntries: () =>
        rt.ctx.store.get<
          Record<string, { sessionId: string; messageCount: number; createdAt: string }>
        >("persistentSessions") || {},
      setEntries: (entries) => {
        rt.ctx.store.set("persistentSessions", entries);
      },
    },
    listActiveSessions: async () => (await rt.bridge.listSessions()) as AgentHostSessionInfo[],
    createSession: async (sessionCwd) => {
      const result = (await rt.dispatchMethod("session.create_session", {
        cwd: sessionCwd,
      })) as { sessionId: string };
      return result.sessionId;
    },
    log,
    formatSessionId: shortId,
  });
}

async function buildBootstrapSystemPrompt(params: {
  cwd: string;
  baseSystemPrompt?: string;
  includeAllSummaries: boolean;
}): Promise<string | undefined> {
  const rt = getRuntime();
  const { cwd, baseSystemPrompt, includeAllSummaries } = params;
  let systemPrompt = baseSystemPrompt;

  await transitionConversation(cwd);

  try {
    const memoryContext = (await withTimeout(
      rt.ctx.call("memory.get_session_context", { cwd, includeAllSummaries }),
      MEMORY_CONTEXT_TIMEOUT_MS,
      "memory.get_session_context",
    )) as MemoryContextResult | null;

    if (memoryContext) {
      const memoryBlock = formatMemoryContext(memoryContext);
      if (memoryBlock) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryBlock}` : memoryBlock;
        log.info("Injected memory context into session bootstrap", {
          recentMessages: memoryContext.recentMessages.length,
          recentSummaries: memoryContext.recentSummaries.length,
        });
      }
    }
  } catch (err) {
    log.warn("Failed to inject memory context (non-fatal)", { error: String(err) });
  }

  return systemPrompt;
}

async function ensureSessionBootstrapped(params: {
  sessionId: string;
  cwd: string;
  workspaceId: string;
  agent: string;
  model: string;
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  baseSystemPrompt?: string;
  includeAllSummaries: boolean;
  purpose?: "chat" | "subagent" | "review" | "test";
  parentSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const rt = getRuntime();
  if (resolveSessionPath(params.sessionId, params.cwd)) return;

  const systemPrompt = await buildBootstrapSystemPrompt({
    cwd: params.cwd,
    baseSystemPrompt: params.baseSystemPrompt,
    includeAllSummaries: params.includeAllSummaries,
  });

  await rt.bridge.createSession({
    sessionId: params.sessionId,
    cwd: params.cwd,
    agent: params.agent,
    model: params.model,
    systemPrompt,
    thinking: params.thinking,
    effort: params.effort,
  });

  rt.registry.upsertSession({
    id: params.sessionId,
    workspaceId: params.workspaceId,
    providerSessionId: params.sessionId,
    model: params.model,
    agent: params.agent,
    purpose: params.purpose || "chat",
    parentSessionId: params.parentSessionId,
    runtimeStatus: "idle",
    metadata: {
      ...(params.metadata || {}),
      bootstrapSystemPrompt: params.baseSystemPrompt,
      bootstrapThinking: params.thinking,
      bootstrapEffort: params.effort,
    },
  });
  log.info("Session bootstrapped", { sessionId: shortId(params.sessionId), cwd: params.cwd });
}

// ── Pipeline stages ──────────────────────────────────────────

function getBootstrapSettings(state: PromptLifecycleState): {
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  baseSystemPrompt?: string;
} {
  const rt = getRuntime();
  const metadata = state.existingMetadata;
  return {
    thinking:
      typeof metadata?.bootstrapThinking === "boolean"
        ? metadata.bootstrapThinking
        : rt.sessionConfig.thinking,
    effort:
      metadata?.bootstrapEffort === "low" ||
      metadata?.bootstrapEffort === "medium" ||
      metadata?.bootstrapEffort === "high" ||
      metadata?.bootstrapEffort === "max"
        ? metadata.bootstrapEffort
        : rt.sessionConfig.effort,
    baseSystemPrompt:
      typeof metadata?.bootstrapSystemPrompt === "string"
        ? metadata.bootstrapSystemPrompt
        : rt.sessionConfig.systemPrompt || undefined,
  };
}

async function resolveSessionStage(input: PromptLifecycleInput): Promise<PromptLifecycleState> {
  const rt = getRuntime();
  let sessionId = input.sessionId;
  if (sessionId === PERSISTENT_SESSION_ID) {
    if (!input.cwd) throw new Error("cwd is required for persistent sessions");
    sessionId = await resolvePersistentSession(input.cwd);
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

  const existing = rt.registry.getStoredSession(sessionId);
  let effectiveCwd = input.cwd;
  let workspaceResult =
    effectiveCwd !== undefined ? rt.registry.getOrCreateWorkspace(effectiveCwd) : undefined;
  if (!effectiveCwd && existing) {
    const storedWorkspace = rt.registry.getWorkspace(existing.workspaceId);
    if (storedWorkspace) {
      effectiveCwd = storedWorkspace.cwd;
      workspaceResult = { workspace: storedWorkspace, created: false };
    }
  }

  return {
    sessionId,
    content: input.content,
    effectiveCwd,
    resolvedModel: input.model || existing?.model || rt.sessionConfig.model,
    agent: input.agent,
    streaming: input.streaming,
    source: input.source,
    existing,
    existingMetadata: (existing?.metadata || null) as SessionBootstrapMetadata | null,
    workspaceResult,
  };
}

async function prepareRuntimeStage(state: PromptLifecycleState): Promise<void> {
  const rt = getRuntime();
  const activeSessions = (await rt.bridge.listSessions()) as AgentHostSessionInfo[];
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
    await rt.bridge.closeSession(state.sessionId);
  }

  if (!state.existing && state.effectiveCwd && state.workspaceResult) {
    rt.registry.upsertSession({
      id: state.sessionId,
      workspaceId: state.workspaceResult.workspace.id,
      providerSessionId: state.sessionId,
      model: state.resolvedModel,
      agent: state.agent,
      purpose: "chat",
      runtimeStatus: "idle",
    });
    rt.registry.setWorkspaceActiveSession(state.workspaceResult.workspace.id, state.sessionId);
    return;
  }

  if (state.existing) {
    touchSession(state.sessionId);
  }
}

async function bootstrapSessionStage(state: PromptLifecycleState): Promise<void> {
  if (!state.effectiveCwd || !state.workspaceResult) return;
  if (resolveSessionPath(state.sessionId, state.effectiveCwd)) return;

  const bootstrap = getBootstrapSettings(state);
  await ensureSessionBootstrapped({
    sessionId: state.sessionId,
    cwd: state.effectiveCwd,
    workspaceId: state.workspaceResult.workspace.id,
    agent: state.agent,
    model: state.resolvedModel,
    thinking: bootstrap.thinking,
    effort: bootstrap.effort,
    baseSystemPrompt: bootstrap.baseSystemPrompt,
    includeAllSummaries: state.workspaceResult.workspace.general,
    purpose: state.existing?.purpose,
    parentSessionId: state.existing?.parentSessionId,
    metadata: state.existing?.metadata,
  });
}

function attachRequestContextStage(
  state: PromptLifecycleState,
  request: { connectionId: string | null; tags: string[] | null },
): void {
  const rt = getRuntime();
  const requestContext: RequestContext = {
    connectionId: request.connectionId,
    tags: request.tags,
    source: state.source,
    responseText: "",
  };
  const binding = rt.sessionActors.bindPromptRequest(state.sessionId, requestContext, {
    streaming: state.streaming,
  });
  if (
    binding.preservedPrimaryConnectionId &&
    binding.preservedPrimaryConnectionId !== request.connectionId
  ) {
    log.info("Preserving primary context", {
      sessionId: shortId(state.sessionId),
      primaryConn: binding.preservedPrimaryConnectionId.slice(0, 8),
      transientConn: request.connectionId?.slice(0, 8),
    });
  }
  state.requestContext = requestContext;
}

async function dispatchStreamingPromptStage(
  state: PromptLifecycleState,
): Promise<{ status: "streaming"; sessionId: string }> {
  const rt = getRuntime();
  const promptStart = Date.now();
  await rt.bridge.prompt(
    state.sessionId,
    state.content,
    state.effectiveCwd,
    state.resolvedModel,
    state.agent,
  );

  const turnListener: SessionEventListener = (event) => {
    if (event.sessionId !== state.sessionId || event.type !== "turn_stop") return;
    const elapsed = Date.now() - promptStart;
    const responseLen = rt.sessionActors.getResponseTextLength(state.sessionId);
    log.info("Streaming turn complete", {
      sessionId: shortId(state.sessionId),
      elapsed: `${elapsed}ms`,
      responseChars: responseLen,
    });
    rt.bridge.offSessionEvent(turnListener);
  };

  rt.bridge.onSessionEvent(turnListener);
  return { status: "streaming", sessionId: state.sessionId };
}

async function dispatchNonStreamingPromptStage(
  state: PromptLifecycleState,
): Promise<{ text: string; sessionId: string; stopReason: string }> {
  const rt = getRuntime();
  const promptStart = Date.now();
  const turnResultPromise = rt.sessionActors.beginTurn(state.sessionId, 300_000);

  try {
    await rt.bridge.prompt(
      state.sessionId,
      state.content,
      state.effectiveCwd,
      state.resolvedModel,
      state.agent,
    );
  } catch (error) {
    rt.sessionActors.failTurn(
      state.sessionId,
      error instanceof Error ? error : new Error(String(error)),
    );
    await turnResultPromise.catch(() => undefined);
    throw error;
  }

  try {
    const result = await turnResultPromise;
    const elapsed = Date.now() - promptStart;
    log.info("Non-streaming prompt complete", {
      sessionId: shortId(state.sessionId),
      elapsed: `${elapsed}ms`,
      responseChars: result.text.length,
      stopReason: result.stopReason,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Prompt timed out after 5 minutes") {
      log.error("Prompt timed out", {
        sessionId: shortId(state.sessionId),
        elapsed: "300s",
      });
    } else if (message.startsWith("Session process died:")) {
      log.error("Non-streaming prompt failed: process died", {
        sessionId: shortId(state.sessionId),
        reason: message.replace("Session process died: ", "") || "unknown",
      });
    }
    throw error;
  }
}

// ── Public API ──────────────────────────────────────────────

export async function runPromptLifecycle(
  input: PromptLifecycleInput,
  request: { connectionId: string | null; tags: string[] | null },
): Promise<{ status: "streaming"; sessionId: string } | { text: string; sessionId: string }> {
  const state = await resolveSessionStage(input);
  await prepareRuntimeStage(state);
  await bootstrapSessionStage(state);
  attachRequestContextStage(state, request);
  if (state.streaming) {
    return await dispatchStreamingPromptStage(state);
  }
  return await dispatchNonStreamingPromptStage(state);
}
