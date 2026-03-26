/**
 * Session Extension
 *
 * Owns all session and workspace lifecycle — the "brain" of Claudia's session management.
 *
 * Gateway is a pure hub: this extension handles create, prompt, history, switch, etc.
 * Other extensions interact via ctx.call("session.*") through the gateway hub.
 */

import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";
import { createLogger, loadConfig, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { AgentHostClient } from "./agent-client";
import type { AgentHostSessionInfo, SessionRuntimeConfig, RequestContext } from "./session-types";
import type { SessionTask } from "./lifecycle/task-workflow";
import { getOrCreateWorkspace, closeDb } from "./workspace";
import {
  closeSessionDb,
  setWorkspaceActiveSession,
  upsertSession,
  type RuntimeStatus,
} from "./session-store";
import { wireSessionEvents } from "./lifecycle/session-events";
import { wireTaskEvents } from "./lifecycle/task-events";
import { sessionMethodDefinitions } from "./session-methods";
import { dispatchMethod } from "./session-dispatch";
import { initRuntime, resetRuntime } from "./runtime";

const log = createLogger("SessionExt", join(homedir(), ".anima", "logs", "session.log"));

// ── Extension factory ────────────────────────────────────────

export function createSessionExtension(config: Record<string, unknown> = {}): AnimaExtension {
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

  // ── Runtime objects (initialized before start, ctx bound in start) ──
  const agentClient = new AgentHostClient(globalConfig.agentHost.url);
  const unsubscribers: Array<() => void> = [];

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

  // ── Method dispatch with logging ───────────────────────────

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

    async start(ctx: ExtensionContext): Promise<void> {
      initRuntime({
        ctx,
        agentClient,
        sessionConfig,
        config,
        requestContexts: new Map<string, RequestContext>(),
        primaryContexts: new Map<string, RequestContext>(),
        tasks: new Map<string, SessionTask>(),
        taskNotificationsSent: new Set<string>(),
        dispatchMethod: handleMethod,
      });

      unsubscribers.push(wireTaskEvents());
      unsubscribers.push(wireSessionEvents());

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
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          /* ignore cleanup failures */
        }
      }
      unsubscribers.length = 0;
      agentClient.disconnect();
      closeSessionDb();
      closeDb();
      resetRuntime();
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
