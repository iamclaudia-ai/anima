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
import { startRefValidator } from "./session-ref-validity";
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
      // Asks GitHub whether extracted PR/issue refs actually exist, and
      // remembers the misses so a hex colour is never re-extracted as a chip.
      instance.runtime.unsubscribers.push(startRefValidator());

      /**
       * Reconcile against what agent-host actually has, on every connect.
       *
       * The subscription is the part that must not be skipped. agent-host
       * broadcasts a session's events only to clients subscribed to it, and a
       * client subscribes by *creating* or *prompting* that session — neither
       * of which a restarted extension does for a session already in flight.
       * A reload mid-turn therefore left us receiving nothing for it: the CLI
       * reached `turn_stop`, agent-host had nobody to send it to, and the row
       * sat on `running` forever. Silent by construction, since a dropped
       * broadcast raises nothing anywhere.
       *
       * Runs on reconnects too, not just startup, because the case with no
       * other safety net is an initial connect that *fails* — the startup path
       * never ran, and the reconnect that eventually succeeds has nothing
       * remembered to restore.
       */
      const syncLiveSessions = async (): Promise<void> => {
        const activeSessions =
          (await instance.runtime.bridge.listSessions()) as AgentHostSessionInfo[];
        instance.runtime.registry.recordConnectedSessions(activeSessions);
        await instance.runtime.bridge.subscribeSessions(activeSessions.map((s) => s.id));
        // Rows claiming to be mid-turn are claims about *now*, and a persisted
        // claim about now is wrong the moment its writer dies. Ground truth
        // lives in agent-host, so every sync re-derives it from there.
        reconcileInFlightStatuses({
          running: new Set(activeSessions.filter((s) => s.isProcessRunning).map((s) => s.id)),
          turnActive: new Set(activeSessions.filter((s) => s.turnActive === true).map((s) => s.id)),
          turnStateUnknown: new Set(
            activeSessions.filter((s) => s.turnActive === undefined).map((s) => s.id),
          ),
        });
      };

      try {
        await instance.runtime.bridge.connect();
        // Awaited, not left to the `onConnected` hook below: startup should be
        // finished when `start()` returns, rather than racing the first prompt.
        await syncLiveSessions();
        log.info("Session extension started 🚀", { url: globalConfig.agentHost.url });
      } catch (error) {
        // `scheduleReconnect()` has already been kicked off inside `connect()`,
        // and the hook below runs the sync when it lands — so a failed first
        // attempt costs a delay, not the subscription. This is the case with no
        // other safety net: nothing was subscribed and nothing was remembered.
        log.warn("Initial agent-host connect failed; reconnecting in background", {
          url: globalConfig.agentHost.url,
          error: String(error),
        });
      } finally {
        // Registered last, so it only ever handles *re*connects — the initial
        // one is handled above, either way it went.
        instance.runtime.bridge.onConnected(() => {
          void syncLiveSessions().catch((error) => {
            log.warn("Failed to sync live sessions after reconnect", { error: String(error) });
          });
        });

        // And on a slow interval, because a status goes stale *mid-life*, not
        // only across a restart. `runtime_status` is a persisted cache of a
        // live fact, so every transition it misses — a dropped event, a
        // provider that never announced the end of a turn — leaves a row
        // asserting something untrue with nothing scheduled to correct it. A
        // sweep is what makes the column self-healing instead of merely
        // usually-right. Matches the transcript reconciler's cadence; it's one
        // cheap RPC and a query over the handful of rows claiming to be busy.
        const sweep = setInterval(() => {
          void syncLiveSessions().catch((error) => {
            log.warn("Live session sweep failed", { error: String(error) });
          });
        }, LIVE_SWEEP_INTERVAL_MS);
        sweep.unref?.();
        instance.runtime.unsubscribers.push(() => clearInterval(sweep));
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

/**
 * How often live session state is re-derived from agent-host.
 *
 * Matches the transcript reconciler's sweep: slow enough to be invisible, fast
 * enough that a row asserting something untrue doesn't sit there all morning.
 */
const LIVE_SWEEP_INTERVAL_MS = 60_000;
if (import.meta.main) runExtensionHost(createSessionExtension);
