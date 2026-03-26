/**
 * Session Extension
 *
 * Owns all session and workspace lifecycle — the "brain" of Claudia's session management.
 *
 * Gateway is a pure hub: this extension handles create, prompt, history, switch, etc.
 * Other extensions interact via ctx.call("session.*") through the gateway hub.
 */

import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";
import { createLogger, loadConfig, shortId, withTimeout, formatElapsed } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { AgentHostClient } from "./agent-client";
import { formatMemoryContext, type MemoryContextResult } from "./memory-context";
import { resolveSessionPath } from "./parse-session";
import {
  type AgentHostSessionInfo,
  type RequestContext,
  type SessionRuntimeConfig,
} from "./session-types";
import { type SessionTask } from "./lifecycle/task-workflow";
import { getOrCreateWorkspace, closeDb } from "./workspace";
import {
  closeSessionDb,
  getStoredSession,
  setWorkspaceActiveSession,
  upsertSession,
  type RuntimeStatus,
} from "./session-store";
import { resolvePersistentSessionForCwd } from "./persistent-sessions";
import { createPromptLifecycleRunner } from "./lifecycle/prompt-lifecycle";
import { createSessionQueryService } from "./lifecycle/session-query";
import { createSessionActivationRunner } from "./lifecycle/session-activation";
import { createTaskWorkflowRunner } from "./lifecycle/task-workflow";
import { createTaskEventBridge } from "./lifecycle/task-events";
import { createSessionEventBridge } from "./lifecycle/session-events";
import { sessionMethodDefinitions } from "./session-methods";
import { createSessionMethodDispatcher } from "./session-dispatch";

const log = createLogger("SessionExt", join(homedir(), ".anima", "logs", "session.log"));

const MEMORY_TRANSITION_TIMEOUT_MS = 1500;
const MEMORY_CONTEXT_TIMEOUT_MS = 2000;

// ── Helper: transition conversation with timeout ─────────────

async function transitionConversation(ctx: ExtensionContext, cwd: string): Promise<void> {
  try {
    await withTimeout(
      ctx.call("memory.transition_conversation", { cwd }),
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

// ── Extension factory ────────────────────────────────────────

export function createSessionExtension(config: Record<string, unknown> = {}): AnimaExtension {
  let ctx: ExtensionContext;

  // ── Configuration ──────────────────────────────────────────
  const globalConfig = loadConfig();
  const globalSessionExtConfig = (globalConfig.extensions?.session?.config || {}) as Record<
    string,
    unknown
  >;
  const configuredModel = (() => {
    if (typeof config.model === "string" && config.model.trim().length > 0) {
      return config.model.trim();
    }
    const globalModel = globalSessionExtConfig.model;
    if (typeof globalModel === "string" && globalModel.trim().length > 0) {
      return globalModel.trim();
    }
    return null;
  })();
  if (!configuredModel) {
    throw new Error(
      "Session extension requires extensions.session.config.model in ~/.anima/anima.json",
    );
  }
  const sessionConfig: SessionRuntimeConfig = {
    model: configuredModel,
    thinking: (config.thinking as boolean | undefined) ?? false,
    effort: (config.effort as "low" | "medium" | "high" | "max" | undefined) || "medium",
    systemPrompt: (config.systemPrompt as string | null | undefined) ?? null,
  };

  // ── Runtime objects ────────────────────────────────────────
  const agentClient = new AgentHostClient(globalConfig.agentHost.url);
  const requestContexts = new Map<string, RequestContext>();
  const primaryContexts = new Map<string, RequestContext>();
  const tasks = new Map<string, SessionTask>();
  const taskNotificationsSent = new Set<string>();
  const taskUnsubscribers: Array<() => void> = [];

  // ── Closures over ctx (not available until start()) ────────

  async function resolvePersistentSession(cwd: string): Promise<string> {
    return resolvePersistentSessionForCwd({
      cwd,
      store: {
        getEntries: () =>
          ctx.store.get<
            Record<string, { sessionId: string; messageCount: number; createdAt: string }>
          >("persistentSessions") || {},
        setEntries: (entries) => {
          ctx.store.set("persistentSessions", entries);
        },
      },
      listActiveSessions: async () => (await agentClient.list()) as AgentHostSessionInfo[],
      createSession: async (sessionCwd) => {
        const result = (await handleMethod("session.create_session", {
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
    const { cwd, baseSystemPrompt, includeAllSummaries } = params;
    let systemPrompt = baseSystemPrompt;

    await transitionConversation(ctx, cwd);

    try {
      const memoryContext = (await withTimeout(
        ctx.call("memory.get_session_context", { cwd, includeAllSummaries }),
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
  }): Promise<void> {
    if (resolveSessionPath(params.sessionId, params.cwd)) return;

    const systemPrompt = await buildBootstrapSystemPrompt({
      cwd: params.cwd,
      baseSystemPrompt: params.baseSystemPrompt,
      includeAllSummaries: params.includeAllSummaries,
    });

    await agentClient.createSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      agent: params.agent,
      model: params.model,
      systemPrompt,
      thinking: params.thinking,
      effort: params.effort,
    });

    upsertSession({
      id: params.sessionId,
      workspaceId: params.workspaceId,
      providerSessionId: params.sessionId,
      model: params.model,
      agent: params.agent,
      purpose: "chat",
      runtimeStatus: "idle",
      metadata: {
        bootstrapSystemPrompt: params.baseSystemPrompt,
        bootstrapThinking: params.thinking,
        bootstrapEffort: params.effort,
      },
    });
    log.info("Session bootstrapped", { sessionId: shortId(params.sessionId), cwd: params.cwd });
  }

  // ── Subsystems ─────────────────────────────────────────────

  const taskEventBridge = createTaskEventBridge({
    tasks,
    taskNotificationsSent,
    requestContexts,
    getCtx: () => ctx,
    sessionConfig,
    agentClient,
  });

  const sessionEventBridge = createSessionEventBridge({
    requestContexts,
    primaryContexts,
    getCtx: () => ctx,
    agentClient,
  });

  const promptLifecycle = createPromptLifecycleRunner({
    sessionConfig,
    requestContexts,
    primaryContexts,
    resolvePersistentSession,
    ensureSessionBootstrapped,
    agentClient,
  });

  const sessionActivation = createSessionActivationRunner({
    sessionConfig,
    transitionConversation: (cwd) => transitionConversation(ctx, cwd),
    agentClient,
  });

  const taskWorkflow = createTaskWorkflowRunner({
    tasks,
    taskNotificationsSent,
    sessionConfig,
    agentClient,
  });

  const sessionQuery = createSessionQueryService({
    sessionConfig,
    getMemoryContext: async (cwd, includeAllSummaries) => {
      return (await ctx.call("memory.get_session_context", {
        cwd,
        includeAllSummaries,
      })) as MemoryContextResult | null;
    },
  });

  // ── Health Check ───────────────────────────────────────────

  function health(): HealthCheckResponse {
    return {
      ok: true,
      status: agentClient.isConnected ? "healthy" : "degraded",
      label: "Sessions",
      metrics: [
        { label: "Agent Host", value: agentClient.isConnected ? "connected" : "disconnected" },
      ],
      actions: [],
      items: [],
    };
  }

  async function healthCheckDetailed(): Promise<HealthCheckResponse> {
    if (!agentClient.isConnected) {
      return {
        ok: false,
        status: "degraded",
        label: "Sessions",
        metrics: [{ label: "Agent Host", value: "disconnected" }],
        actions: [],
        items: [],
      };
    }

    let sessions: AgentHostSessionInfo[] = [];
    try {
      sessions = (await agentClient.list()) as AgentHostSessionInfo[];
    } catch {
      return {
        ok: false,
        status: "degraded",
        label: "Sessions",
        metrics: [
          { label: "Agent Host", value: "connected" },
          { label: "Sessions", value: "unavailable" },
        ],
        actions: [],
        items: [],
      };
    }

    const visible = sessions.filter((s) => s.isProcessRunning);
    return {
      ok: true,
      status: "healthy",
      label: "Sessions",
      metrics: [
        { label: "Agent Host", value: "connected" },
        { label: "Active Sessions", value: visible.filter((s) => s.isActive).length },
        { label: "Running SDK", value: visible.length },
        { label: "Stale", value: visible.filter((s) => s.stale).length },
      ],
      actions: [],
      items: [...visible]
        .sort((a, b) => {
          const aTs = Date.parse(a.lastActivity || "");
          const bTs = Date.parse(b.lastActivity || "");
          return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        })
        .map((s) => ({
          id: s.id,
          label: s.cwd || s.id,
          status: !s.isActive ? "inactive" : s.stale ? "stale" : "healthy",
          details: {
            model: s.model || "unknown",
            running: s.isProcessRunning ? "yes" : "no",
            lastActivity: s.lastActivity || "n/a",
            lastActivityAgo: formatElapsed(Date.now() - Date.parse(s.lastActivity)),
          },
        })),
    };
  }

  // ── Method dispatch with logging ───────────────────────────

  const dispatchMethod = createSessionMethodDispatcher({
    config,
    sessionConfig,
    getCtx: () => ctx,
    requestState: { requestContexts, primaryContexts, tasks },
    agentClient,
    promptLifecycle,
    sessionActivation,
    taskWorkflow,
    taskEventBridge,
    sessionQuery,
    healthCheckDetailed,
  });

  async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    const isRead =
      method === "session.list_sessions" ||
      method === "session.list_workspaces" ||
      method === "session.get_workspace" ||
      method === "session.health_check" ||
      method === "session.rotate_persistent_sessions";
    if (!isRead) {
      log.info(
        `→ ${method}`,
        params.sessionId ? { sessionId: shortId(params.sessionId as string) } : undefined,
      );
    }

    const start = Date.now();
    try {
      const result = await dispatchMethod(method, params);
      const elapsed = Date.now() - start;
      if (!isRead && elapsed > 100) {
        log.info(`← ${method} OK (${elapsed}ms)`);
      }
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      log.error(`← ${method} FAILED (${elapsed}ms)`, {
        error: err instanceof Error ? err.message : String(err),
        ...(params.sessionId ? { sessionId: shortId(params.sessionId as string) } : {}),
      });
      throw err;
    }
  }

  // ── Extension Interface ────────────────────────────────────

  return {
    id: "session",
    name: "Session Manager",
    methods: sessionMethodDefinitions,
    events: ["stream.*", "session.task.*"],
    sourceRoutes: [],

    async start(extCtx: ExtensionContext): Promise<void> {
      ctx = extCtx;
      taskUnsubscribers.push(taskEventBridge.wire());
      taskUnsubscribers.push(sessionEventBridge.wire());
      try {
        await agentClient.connect();
        const activeSessions = (await agentClient.list()) as AgentHostSessionInfo[];
        for (const session of activeSessions) {
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
        log.info("Session extension started 🚀", { url: globalConfig.agentHost.url });
      } catch (error) {
        log.warn("Failed to connect to agent-host, will retry in background", {
          error: String(error),
        });
      }
    },

    async stop(): Promise<void> {
      for (const unsub of taskUnsubscribers) {
        try {
          unsub();
        } catch {
          /* ignore cleanup failures */
        }
      }
      taskUnsubscribers.length = 0;
      tasks.clear();
      agentClient.disconnect();
      closeSessionDb();
      closeDb();
      log.info("Session extension stopped");
    },

    handleMethod,
    health,
  };
}

export default createSessionExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createSessionExtension);
