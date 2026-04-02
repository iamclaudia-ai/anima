/**
 * Session Extension Runtime
 *
 * Shared singleton that holds all runtime state for the session extension.
 * Initialized once during start(), pulled by lifecycle modules on demand.
 *
 * This is the pull model: modules call getRuntime() to access what they
 * need at execution time, rather than receiving deps at construction time.
 */

import type { ExtensionContext } from "@anima/shared";
import type { SessionRuntimeConfig } from "./session-types";
import type { SessionTask } from "./lifecycle/task-workflow";
import type { SessionActorRegistry } from "./session-actor-registry";
import type { SessionAgentBridge } from "./session-agent-bridge";
import type { SessionRegistry } from "./session-registry";

export interface SessionRuntime {
  /** Extension context — available after start() */
  ctx: ExtensionContext;
  /** Actor owning agent-host transport and event bridge subscriptions */
  bridge: SessionAgentBridge;
  /** Actor owning workspace/session registry state */
  registry: SessionRegistry;
  /** Resolved session configuration (model, thinking, effort) */
  sessionConfig: SessionRuntimeConfig;
  /** Extension config from anima.json */
  config: Record<string, unknown>;
  /** Per-session prompt/session actors */
  sessionActors: SessionActorRegistry;
  /** In-memory task cache */
  tasks: Map<string, SessionTask>;
  /** Prevents duplicate task completion notifications */
  taskNotificationsSent: Set<string>;
  /** Late-bound method dispatcher (set after dispatch is ready) */
  dispatchMethod: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

let _runtime: SessionRuntime | null = null;

/** Initialize the runtime singleton. Called once during extension start(). */
export function initRuntime(runtime: SessionRuntime): void {
  _runtime = runtime;
}

/** Get the runtime. Throws if called before initRuntime(). */
export function getRuntime(): SessionRuntime {
  if (!_runtime) throw new Error("Session runtime not initialized — start() not called yet");
  return _runtime;
}

/** Reset runtime (for stop/cleanup). */
export function resetRuntime(): void {
  _runtime = null;
}
