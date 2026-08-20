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
import { createStandardExtension } from "@anima/extension-host";
import { join } from "node:path";
import { homedir } from "node:os";
import { AgentHostClient } from "./agent-client";
import type { AgentHostSessionInfo, SessionRuntimeConfig } from "./session-types";
import type { SessionSubagent } from "./lifecycle/subagent-workflow";
import { closeDb } from "./workspace";
import { closeSessionDb } from "./session-store";
import { wireSessionEvents } from "./lifecycle/session-events";
import { startReconciler } from "./session-reconciler";
import { wireSubagentEvents } from "./lifecycle/subagent-events";
import { sessionMethodDefinitions } from "./session-methods";
import { createSessionMethodHandlers } from "./session-dispatch";
import { getRuntime, initRuntime, resetRuntime } from "./runtime";
import { SessionActorRegistry } from "./session-actor-registry";
import { SessionAgentBridge } from "./session-agent-bridge";
import { SessionRegistry } from "./session-registry";
import { reconcileInFlightStatuses } from "./session-status-events";

const log = createLogger("SessionExt", join(homedir(), ".anima", "logs", "session.log"));

interface SessionExtensionRuntime {
  bridge: SessionAgentBridge;
  registry: SessionRegistry;
  unsubscribers: Array<() => void>;
}

function withAuthToken(url: string, token: string | undefined): string {
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

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
  const agentClient = new AgentHostClient(
    withAuthToken(globalConfig.agentHost.url, globalConfig.gateway.token),
  );
  const bridge = new SessionAgentBridge(agentClient);
  const registry = new SessionRegistry();
  const methodHandlers = createSessionMethodHandlers();

  // ── Health Check ───────────────────────────────────────────

  function health(): HealthCheckResponse {
    return {
      ok: true,
      status: bridge.isConnected ? "healthy" : "degraded",
      label: "Sessions",
      metrics: [{ label: "Agent Host", value: bridge.isConnected ? "connected" : "disconnected" }],
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
      const handler = methodHandlers[method];
      if (!handler) {
        throw new Error(`Unknown method: ${method}`);
      }
      const runtime = getRuntime();
      const result = await handler(params, runtime.ctx);
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

  return createStandardExtension<SessionExtensionRuntime>({
    id: "session",
    name: "Session Manager",
    createRuntime(ctx): SessionExtensionRuntime {
      initRuntime({
        ctx,
        bridge,
        registry,
        sessionConfig,
        config,
        sessionActors: new SessionActorRegistry(),
        subagents: new Map<string, SessionSubagent>(),
        subagentNotificationsSent: new Set<string>(),
        dispatchMethod: handleMethod,
      });

      return {
        bridge,
        registry,
        unsubscribers: [],
      };
    },
    methods: sessionMethodDefinitions.map((definition) => ({
      definition,
      handle: async (params, instance) => {
        const handler = methodHandlers[definition.name];
        if (!handler) {
          throw new Error(`Unknown method: ${definition.name}`);
        }
        return await handler(params, instance.ctx);
      },
    })),
    events: [
      "stream.*",
      "session.subagent.*",
      // Broadcast, not connection-scoped: these are what make every open tab
      // agree about the session list rather than holding its own snapshot.
      "session.status_changed",
      "session.list_changed",
      // The heartbeat: re-asserts a running session so a tab that missed the
      // edge still shows a spinner. See `emitActivity`.
      "session.activity",
    ],
    sourceRoutes: [],

    async start(instance): Promise<void> {
      instance.runtime.unsubscribers.push(wireSubagentEvents());
      instance.runtime.unsubscribers.push(wireSessionEvents());
      // Keeps the sessions table current off the request path, and is the only
      // thing that notices sessions created outside Anima (the raw CLI).
      instance.runtime.unsubscribers.push(startReconciler());

      try {
        await instance.runtime.bridge.connect();
        const activeSessions =
          (await instance.runtime.bridge.listSessions()) as AgentHostSessionInfo[];
        instance.runtime.registry.recordConnectedSessions(activeSessions);
        // Rows claiming to be mid-turn are claims about a process that exists
        // now. Nothing writes the closing transition when we die mid-turn, so
        // without this a restart leaves them green forever.
        reconcileInFlightStatuses(
          new Set(activeSessions.filter((s) => s.isProcessRunning).map((s) => s.id)),
        );
        log.info("Session extension started 🚀", { url: globalConfig.agentHost.url });
      } catch (error) {
        // AgentHostClient.scheduleReconnect() has been kicked off inside
        // connect(); the extension will pick up the agent-host once it's
        // listening. We can't preload the resumable session list here, but
        // lazy-resume on next prompt covers that.
        log.warn("Initial agent-host connect failed; reconnecting in background", {
          url: globalConfig.agentHost.url,
          error: String(error),
        });
      }
    },

    async stop(instance): Promise<void> {
      for (const unsub of instance.runtime.unsubscribers) {
        try {
          unsub();
        } catch {
          /* ignore cleanup failures */
        }
      }
      instance.runtime.unsubscribers.length = 0;
      instance.runtime.bridge.disconnect();
      closeSessionDb();
      closeDb();
      resetRuntime();
      log.info("Session extension stopped");
    },
    health,
  })(config);
}

export default createSessionExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createSessionExtension);
