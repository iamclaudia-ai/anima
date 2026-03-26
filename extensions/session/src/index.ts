/**
 * Session Extension
 *
 * Owns all session and workspace lifecycle — the "brain" of Claudia's session management.
 * Session lifecycle, workspace management, and Claude SDK integration.
 *
 * Gateway is a pure hub: this extension handles create, prompt, history, switch, etc.
 * Other extensions interact via ctx.call("session.*") through the gateway hub.
 *
 * Method naming: session.verb_noun (e.g. session.health_check)
 */

import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";
import {
  createLogger,
  loadConfig,
  PERSISTENT_SESSION_ID,
  shortId,
  withTimeout,
  formatElapsed,
} from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { AgentHostClient } from "./agent-client";
import { discoverSessions } from "./claude-projects";
import { formatMemoryContext, type MemoryContextResult } from "./memory-context";
import {
  parseSessionFile,
  parseSessionFilePaginated,
  parseSessionUsage,
  resolveSessionPath,
} from "./parse-session";
import {
  listWorkspaces,
  getWorkspace,
  getWorkspaceByCwd,
  getOrCreateWorkspace,
  deleteWorkspace,
  closeDb,
} from "./workspace";
import {
  closeSessionDb,
  getStoredSession,
  getWorkspaceActiveSession,
  listTaskSessions,
  listWorkspaceSessions,
  setWorkspaceActiveSession,
  touchSession,
  upsertSession,
  type RuntimeStatus,
  type StoredSession,
} from "./session-store";
import { resolvePersistentSessionForCwd } from "./persistent-sessions";
import { createPromptLifecycleRunner } from "./lifecycle/prompt-lifecycle";
import { createSessionQueryService } from "./lifecycle/session-query";
import { createSessionActivationRunner } from "./lifecycle/session-activation";
import {
  createTaskWorkflowRunner,
  type SessionTask,
  toSessionTaskFromStored,
} from "./lifecycle/task-workflow";
import { createTaskEventBridge } from "./lifecycle/task-events";
import { createSessionEventBridge } from "./lifecycle/session-events";
import { sessionMethodDefinitions } from "./session-methods";
import { createSessionMethodDispatcher } from "./session-dispatch";

const log = createLogger("SessionExt", join(homedir(), ".anima", "logs", "session.log"));

interface AgentHostSessionInfo {
  id: string;
  cwd: string;
  model: string;
  isActive: boolean;
  isProcessRunning: boolean;
  createdAt: string;
  lastActivity: string;
  healthy: boolean;
  stale: boolean;
}

interface SessionRuntimeConfig {
  model: string;
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  systemPrompt: string | null;
}

const MEMORY_TRANSITION_TIMEOUT_MS = 1500;
const MEMORY_CONTEXT_TIMEOUT_MS = 2000;

// ── Session Discovery ────────────────────────────────────────

/**
 * Get list of child directories from a given path.
 * Expands ~ to home directory.
 * Returns directory names sorted alphabetically.
 */
function getDirectories(path: string): string[] {
  try {
    // Expand ~ to home directory
    const expandedPath = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

    if (!existsSync(expandedPath)) {
      return [];
    }

    const stat = statSync(expandedPath);
    if (!stat.isDirectory()) {
      return [];
    }

    // Read directory entries
    const entries = readdirSync(expandedPath, { withFileTypes: true });

    // Filter to directories only, exclude hidden directories (starting with .)
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();

    return directories;
  } catch (error) {
    log.warn("Failed to read directories", { path, error: String(error) });
    return [];
  }
}

function toRuntimeStatusFromSessionEvent(type: string): RuntimeStatus | null {
  if (type === "process_started") return "running";
  if (type === "process_ended" || type === "turn_stop") return "idle";
  return null;
}

// ── Request context tracking ─────────────────────────────────

interface RequestContext {
  connectionId: string | null;
  tags: string[] | null;
  source?: string;
  responseText: string;
}

/**
 * Merge tags from a primary (streaming) context and the current transient context.
 * The primary context's tags are authoritative — e.g., voice.speak from the web UI
 * should persist even when a CLI command or notification temporarily overrides
 * the requestContext for routing purposes.
 */
function mergeTags(primary: string[] | null, current: string[] | null): string[] | null {
  if (!primary && !current) return null;
  if (!primary) return current;
  if (!current) return primary;
  // Deduplicate
  const merged = new Set([...primary, ...current]);
  return Array.from(merged);
}

// ── Memory Context Formatting ────────────────────────────────

// ── Extension factory ────────────────────────────────────────

export function createSessionExtension(config: Record<string, unknown> = {}): AnimaExtension {
  let ctx: ExtensionContext;

  // Load global configuration for non-session settings (e.g., agent-host URL).
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
  const agentHostConfig = globalConfig.agentHost;

  // ── Persistent Sessions ──────────────────────────────────────
  // Extensions like iMessage and Voice Mode pass PERSISTENT_SESSION_ID as
  // the sessionId. We resolve the real sessionId from ctx.store, keyed by cwd.
  // If no session exists for that cwd, we create one. If the stored session
  // is stale/dead, we replace it. Rotation is handled externally by the
  // scheduler calling session.rotate_persistent_sessions.

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
        })) as {
          sessionId: string;
        };
        return result.sessionId;
      },
      log,
      formatSessionId: sid,
    });
  }

  // Connect to agent-host via WebSocket for SDK process isolation.
  // SDK processes (Claude query()) run in the agent-host server and survive
  // gateway/extension restarts. Session extension is a thin RPC client.
  const agentClient = new AgentHostClient(agentHostConfig.url);

  // Per-session request context (for streaming events).
  // requestContexts holds the CURRENT active context (may be transient from CLI/notification).
  // primaryContexts holds the long-lived streaming context from the original caller (e.g., web UI).
  // When emitting events, tags are merged from both so voice.speak persists across tool calls.
  const requestContexts = new Map<string, RequestContext>();
  const primaryContexts = new Map<string, RequestContext>();
  const tasks = new Map<string, SessionTask>();
  const taskNotificationsSent = new Set<string>();
  const taskUnsubscribers: Array<() => void> = [];

  async function buildBootstrapSystemPrompt(params: {
    cwd: string;
    baseSystemPrompt?: string;
    includeAllSummaries: boolean;
  }): Promise<string | undefined> {
    const { cwd, baseSystemPrompt, includeAllSummaries } = params;
    let systemPrompt = baseSystemPrompt;

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

    try {
      const memoryContext = (await withTimeout(
        ctx.call("memory.get_session_context", {
          cwd,
          includeAllSummaries,
        }),
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
    if (resolveSessionPath(params.sessionId, params.cwd)) {
      return;
    }

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
    log.info("Session bootstrapped", { sessionId: sid(params.sessionId), cwd: params.cwd });
  }

  function wireSessionEventBridge(): void {
    taskUnsubscribers.push(sessionEventBridge.wire());
  }

  function wireTaskEventBridge(): void {
    taskUnsubscribers.push(taskEventBridge.wire());
  }

  // ── Method Definitions ─────────────────────────────────────

  const methods = sessionMethodDefinitions;

  // ── Method Handler ─────────────────────────────────────────

  /** Short session ID for logging */
  const sid = shortId;

  /** Summarize prompt shape for logging without storing user content */
  const summarizePrompt = (content: string | unknown[]) => {
    if (typeof content === "string") {
      return {
        kind: "text",
        chars: content.length,
      };
    }

    const blocks = content as Array<Record<string, unknown>>;
    let textBlocks = 0;
    let imageBlocks = 0;
    let otherBlocks = 0;

    for (const block of blocks) {
      if (block?.type === "text") textBlocks++;
      else if (block?.type === "image") imageBlocks++;
      else otherBlocks++;
    }

    return {
      kind: "blocks",
      blocks: blocks.length,
      textBlocks,
      imageBlocks,
      otherBlocks,
    };
  };

  const taskEventBridge = createTaskEventBridge({
    tasks,
    taskNotificationsSent,
    requestContexts,
    getCtx: () => ctx,
    getStoredSession,
    upsertSession,
    sessionConfig,
    sendPrompt: async (sessionId, content, cwd, model, agent) => {
      await agentClient.prompt(sessionId, content, cwd, model, agent);
    },
    onTaskEvent: (listener) => {
      agentClient.on("task.event", listener);
    },
    removeTaskEventListener: (listener) => {
      agentClient.removeListener("task.event", listener);
    },
    sid,
    log,
  });

  const sessionEventBridge = createSessionEventBridge({
    requestContexts,
    primaryContexts,
    getCtx: () => ctx,
    mergeTags,
    toRuntimeStatusFromSessionEvent,
    touchSession,
    onSessionEvent: (listener) => {
      agentClient.on("session.event", listener);
    },
    removeSessionEventListener: (listener) => {
      agentClient.removeListener("session.event", listener);
    },
  });

  const promptLifecycle = createPromptLifecycleRunner({
    session: {
      persistentSessionId: PERSISTENT_SESSION_ID,
      resolvePersistentSession,
      getStoredSession,
      getWorkspace,
      getOrCreateWorkspace,
      setWorkspaceActiveSession,
      touchSession,
      upsertSession,
      resolveSessionPath,
      ensureSessionBootstrapped,
      listActiveSessions: async () => (await agentClient.list()) as AgentHostSessionInfo[],
      closeSession: async (sessionId) => {
        await agentClient.close(sessionId);
      },
      promptSession: async (sessionId, content, cwd, model, agent) => {
        await agentClient.prompt(sessionId, content, cwd, model, agent);
      },
      onSessionEvent: (listener) => {
        agentClient.on("session.event", listener);
      },
      removeSessionEventListener: (listener) => {
        agentClient.removeListener("session.event", listener);
      },
    },
    requestState: {
      requestContexts,
      primaryContexts,
    },
    services: {
      sessionConfig,
      log,
      sid,
      summarizePrompt,
    },
  });

  const sessionActivation = createSessionActivationRunner({
    sessionConfig,
    log,
    sid,
    transitionConversation: async (cwd) => {
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
    },
    getStoredSession,
    getOrCreateWorkspace,
    getWorkspaceActiveSession,
    setWorkspaceActiveSession,
    upsertSession,
    listActiveSessions: async () => (await agentClient.list()) as AgentHostSessionInfo[],
    closeSession: async (sessionId) => {
      await agentClient.close(sessionId);
    },
    promptSession: async (sessionId, content, cwd, model) => {
      await agentClient.prompt(sessionId, content, cwd, model);
    },
    createSession: async ({ cwd, model }) => {
      return await agentClient.createSession({ cwd, model });
    },
  });

  const taskWorkflow = createTaskWorkflowRunner({
    tasks,
    taskNotificationsSent,
    sessionConfig,
    getStoredSession,
    getWorkspace,
    getOrCreateWorkspace,
    listTaskSessions,
    upsertSession,
    listActiveSessions: async () => (await agentClient.list()) as AgentHostSessionInfo[],
    startTask: async (params) => {
      return await agentClient.startTask(params);
    },
    listTasks: async (params) => {
      return (await agentClient.listTasks(params)) as { tasks?: SessionTask[] };
    },
    interruptTask: async (taskId) => {
      return await agentClient.interruptTask(taskId);
    },
  });

  const sessionQuery = createSessionQueryService({
    sessionConfig,
    log,
    sid,
    getOrCreateWorkspace,
    listWorkspaceSessions,
    discoverSessions,
    upsertSession,
    resolveSessionPath,
    parseSessionFilePaginated,
    parseSessionUsage,
    getWorkspaceByCwd,
    getMemoryContext: async (cwd, includeAllSummaries) => {
      return (await ctx.call("memory.get_session_context", {
        cwd,
        includeAllSummaries,
      })) as MemoryContextResult | null;
    },
    formatMemoryContext,
  });

  async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Log all method calls (except high-frequency reads)
    const isRead =
      method === "session.list_sessions" ||
      method === "session.list_workspaces" ||
      method === "session.get_workspace" ||
      method === "session.health_check" ||
      method === "session.rotate_persistent_sessions";
    if (!isRead) {
      log.info(
        `→ ${method}`,
        params.sessionId ? { sessionId: sid(params.sessionId as string) } : undefined,
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
        ...(params.sessionId ? { sessionId: sid(params.sessionId as string) } : {}),
      });
      throw err;
    }
  }

  const dispatchMethod = createSessionMethodDispatcher({
    config,
    sessionConfig,
    log,
    sid,
    getCtx: () => ctx,
    getDirectories,
    getStoredSession,
    getWorkspace,
    getOrCreateWorkspace,
    setWorkspaceActiveSession,
    upsertSession,
    requestState: {
      requestContexts,
      primaryContexts,
      tasks,
    },
    agent: {
      list: async () => (await agentClient.list()) as Array<{ id: string }>,
      interrupt: async (sessionId) => {
        return await agentClient.interrupt(sessionId);
      },
      close: async (sessionId) => {
        await agentClient.close(sessionId);
      },
      setPermissionMode: async (sessionId, mode) => {
        return await agentClient.setPermissionMode(sessionId, mode);
      },
      sendToolResult: async (sessionId, toolUseId, content, isError) => {
        return await agentClient.sendToolResult(sessionId, toolUseId, content, isError);
      },
      getTask: async (taskId) => {
        return (await agentClient.getTask(taskId)) as { task?: SessionTask | null };
      },
    },
    promptLifecycle,
    sessionActivation,
    taskWorkflow,
    taskEventBridge,
    sessionQuery,
    listWorkspaces,
    deleteWorkspace,
    healthCheckDetailed,
  });

  // ── Health Check ───────────────────────────────────────────

  function health(): HealthCheckResponse {
    const agentHostConnected = agentClient.isConnected;
    return {
      ok: true,
      status: agentHostConnected ? "healthy" : "degraded",
      label: "Sessions",
      metrics: [{ label: "Agent Host", value: agentHostConnected ? "connected" : "disconnected" }],
      actions: [],
      items: [],
    };
  }

  async function healthCheckDetailed(): Promise<HealthCheckResponse> {
    const agentHostConnected = agentClient.isConnected;
    if (!agentHostConnected) {
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

    const visibleSessions = sessions.filter((s) => s.isProcessRunning);
    const activeCount = visibleSessions.filter((s) => s.isActive).length;
    const runningCount = visibleSessions.length;
    const staleCount = visibleSessions.filter((s) => s.stale).length;
    const sortedSessions = [...visibleSessions].sort((a, b) => {
      const aTs = Date.parse(a.lastActivity || "");
      const bTs = Date.parse(b.lastActivity || "");
      const safeA = Number.isFinite(aTs) ? aTs : 0;
      const safeB = Number.isFinite(bTs) ? bTs : 0;
      return safeB - safeA;
    });

    return {
      ok: true,
      status: "healthy",
      label: "Sessions",
      metrics: [
        { label: "Agent Host", value: "connected" },
        { label: "Active Sessions", value: activeCount },
        { label: "Running SDK", value: runningCount },
        { label: "Stale", value: staleCount },
      ],
      actions: [],
      items: sortedSessions.map((session) => ({
        id: session.id,
        label: session.cwd || session.id,
        status: !session.isActive ? "inactive" : session.stale ? "stale" : "healthy",
        details: {
          model: session.model || "unknown",
          running: session.isProcessRunning ? "yes" : "no",
          lastActivity: session.lastActivity || "n/a",
          lastActivityAgo: formatElapsed(Date.now() - Date.parse(session.lastActivity)),
        },
      })),
    };
  }

  // ── Extension Interface ────────────────────────────────────

  return {
    id: "session",
    name: "Session Manager",
    methods,
    events: ["stream.*", "session.task.*"],
    sourceRoutes: [],

    async start(extCtx: ExtensionContext): Promise<void> {
      ctx = extCtx;
      wireTaskEventBridge();
      wireSessionEventBridge();
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
        log.info("Session extension started 🚀", { url: agentHostConfig.url });
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
          // ignore cleanup failures
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
