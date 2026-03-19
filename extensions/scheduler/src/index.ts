#!/usr/bin/env bun
/**
 * Scheduler Extension — Autonomous Task Scheduling
 *
 * Durable one-shot and recurring task scheduling with JSON file persistence.
 * Tasks survive gateway restarts. A 5-second check loop fires due tasks
 * and emits events through the gateway event bus.
 *
 * Task types:
 *   - "once"     — Fire at a specific ISO timestamp (or delay from now)
 *   - "interval" — Fire every N seconds (e.g. "300" for 5 minutes)
 *   - "cron"     — Fire on cron schedule (future, not needed for demo)
 *
 * Actions:
 *   - "emit"           — Emit a gateway event with payload
 *   - "extension_call" — Call an extension method via ctx.call()
 *   - "notification"   — Emit scheduler.notification event (convenience)
 */

import type { ClaudiaExtension, ExtensionContext, HealthCheckResponse } from "@claudia/shared";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────

interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  type: "once" | "interval";
  /** ISO timestamp when this task should next fire */
  fireAt: string;
  /** For interval tasks: repeat interval in seconds */
  intervalSeconds?: number;
  action: {
    type: "emit" | "extension_call" | "notification";
    /** Event name (for emit/notification) or method name (for extension_call) */
    target: string;
    /** Payload to include */
    payload?: Record<string, unknown>;
  };
  enabled: boolean;
  createdAt: string;
  firedCount: number;
}

interface TaskStore {
  tasks: ScheduledTask[];
}

// ── Persistence ──────────────────────────────────────────────

const STORE_DIR = join(homedir(), ".claudia");
const STORE_PATH = join(STORE_DIR, "scheduled-tasks.json");

function loadStore(): TaskStore {
  try {
    if (!existsSync(STORE_PATH)) return { tasks: [] };
    const raw = readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as TaskStore;
  } catch {
    return { tasks: [] };
  }
}

function saveStore(store: TaskStore): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ── Extension Factory ────────────────────────────────────────

export function createSchedulerExtension(config: Record<string, unknown> = {}): ClaudiaExtension {
  let ctx: ExtensionContext | null = null;
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  const CHECK_INTERVAL_MS = 5_000; // Check every 5 seconds

  // ── Task check loop ──────────────────────────────────────

  async function checkAndFireTasks(): Promise<void> {
    if (!ctx) return;

    const store = loadStore();
    const now = Date.now();
    let changed = false;
    const toRemove: string[] = [];

    for (const task of store.tasks) {
      if (!task.enabled) continue;

      const fireTime = new Date(task.fireAt).getTime();
      if (isNaN(fireTime) || fireTime > now) continue;

      // Task is due — fire it!
      ctx.log.info(`Firing scheduled task: ${task.name}`, { id: task.id, action: task.action });
      task.firedCount++;
      changed = true;

      try {
        switch (task.action.type) {
          case "emit":
            ctx.emit(task.action.target, {
              taskId: task.id,
              taskName: task.name,
              ...task.action.payload,
            });
            break;

          case "notification":
            ctx.emit("scheduler.notification", {
              taskId: task.id,
              taskName: task.name,
              message: task.action.target,
              ...task.action.payload,
            });
            break;

          case "extension_call":
            await ctx.call(task.action.target, task.action.payload ?? {});
            break;
        }

        // Also emit a generic task_fired event for any listeners
        ctx.emit("scheduler.task_fired", {
          taskId: task.id,
          taskName: task.name,
          action: task.action,
          firedAt: new Date().toISOString(),
        });
      } catch (error) {
        ctx.log.error(`Failed to fire task: ${task.name}`, { id: task.id, error: String(error) });
      }

      // Handle task lifecycle
      if (task.type === "once") {
        toRemove.push(task.id);
      } else if (task.type === "interval" && task.intervalSeconds) {
        // Schedule next run
        task.fireAt = new Date(now + task.intervalSeconds * 1000).toISOString();
      }
    }

    // Remove completed one-shot tasks
    if (toRemove.length > 0) {
      store.tasks = store.tasks.filter((t) => !toRemove.includes(t.id));
      changed = true;
    }

    if (changed) saveStore(store);
  }

  // ── Method definitions ───────────────────────────────────

  const methods = [
    {
      name: "scheduler.add_task",
      description:
        "Schedule a new task. Use delaySeconds for relative timing or fireAt for absolute.",
      inputSchema: z.object({
        name: z.string().describe("Human-readable task name"),
        description: z.string().optional(),
        type: z.enum(["once", "interval"]).default("once"),
        fireAt: z.string().optional().describe("ISO timestamp when task should fire"),
        delaySeconds: z
          .number()
          .optional()
          .describe("Seconds from now to fire (alternative to fireAt)"),
        intervalSeconds: z
          .number()
          .optional()
          .describe("For interval tasks: repeat every N seconds"),
        action: z.object({
          type: z.enum(["emit", "extension_call", "notification"]).default("notification"),
          target: z.string().describe("Event name, method name, or notification message"),
          payload: z.record(z.unknown()).optional(),
        }),
      }),
    },
    {
      name: "scheduler.list_tasks",
      description: "List all scheduled tasks",
      inputSchema: z.object({}),
    },
    {
      name: "scheduler.cancel_task",
      description: "Cancel a scheduled task by ID",
      inputSchema: z.object({
        taskId: z.string(),
      }),
    },
    {
      name: "scheduler.health_check",
      description: "Return scheduler health and stats",
      inputSchema: z.object({}),
    },
  ];

  // ── Method handlers ──────────────────────────────────────

  async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "scheduler.add_task": {
        const {
          name,
          description,
          type = "once",
          fireAt,
          delaySeconds,
          intervalSeconds,
          action,
        } = params as {
          name: string;
          description?: string;
          type?: "once" | "interval";
          fireAt?: string;
          delaySeconds?: number;
          intervalSeconds?: number;
          action: {
            type: "emit" | "extension_call" | "notification";
            target: string;
            payload?: Record<string, unknown>;
          };
        };

        // Compute fire time
        let computedFireAt: string;
        if (delaySeconds !== undefined) {
          computedFireAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        } else if (fireAt) {
          computedFireAt = fireAt;
        } else {
          throw new Error("Either fireAt or delaySeconds is required");
        }

        const task: ScheduledTask = {
          id: crypto.randomUUID(),
          name,
          description,
          type,
          fireAt: computedFireAt,
          intervalSeconds: type === "interval" ? intervalSeconds : undefined,
          action,
          enabled: true,
          createdAt: new Date().toISOString(),
          firedCount: 0,
        };

        const store = loadStore();
        store.tasks.push(task);
        saveStore(store);

        ctx?.log.info(`Task scheduled: ${name}`, {
          id: task.id,
          type,
          fireAt: computedFireAt,
          action: action.type,
        });

        return {
          ok: true,
          taskId: task.id,
          name,
          fireAt: computedFireAt,
          type,
        };
      }

      case "scheduler.list_tasks": {
        const store = loadStore();
        return {
          tasks: store.tasks.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            type: t.type,
            fireAt: t.fireAt,
            enabled: t.enabled,
            firedCount: t.firedCount,
            action: t.action,
            createdAt: t.createdAt,
          })),
          count: store.tasks.length,
        };
      }

      case "scheduler.cancel_task": {
        const { taskId } = params as { taskId: string };
        const store = loadStore();
        const before = store.tasks.length;
        store.tasks = store.tasks.filter((t) => t.id !== taskId);
        saveStore(store);

        const removed = before - store.tasks.length;
        ctx?.log.info(`Task cancelled: ${taskId}`, { removed });

        return { ok: true, taskId, removed };
      }

      case "scheduler.health_check": {
        const store = loadStore();
        const now = Date.now();
        const pending = store.tasks.filter(
          (t) => t.enabled && new Date(t.fireAt).getTime() > now,
        ).length;
        const overdue = store.tasks.filter(
          (t) => t.enabled && new Date(t.fireAt).getTime() <= now,
        ).length;

        return {
          ok: true,
          status: "healthy",
          label: "Scheduler",
          metrics: [
            { label: "Total Tasks", value: store.tasks.length },
            { label: "Pending", value: pending },
            { label: "Overdue", value: overdue },
          ],
        } satisfies HealthCheckResponse;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ── Extension lifecycle ──────────────────────────────────

  return {
    id: "scheduler",
    name: "Task Scheduler",
    methods,
    events: ["scheduler.task_fired", "scheduler.notification"],

    async start(context: ExtensionContext): Promise<void> {
      ctx = context;

      // Load existing tasks and log status
      const store = loadStore();
      ctx.log.info(`Scheduler started — ${store.tasks.length} task(s) loaded`);

      // Start the check loop
      checkInterval = setInterval(() => {
        checkAndFireTasks().catch((err) => {
          ctx?.log.error("Task check failed", { error: String(err) });
        });
      }, CHECK_INTERVAL_MS);

      ctx.log.info(`Task check loop started (every ${CHECK_INTERVAL_MS / 1000}s)`);
    },

    async stop(): Promise<void> {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
      ctx?.log.info("Scheduler stopped");
      ctx = null;
    },

    handleMethod,

    health() {
      return { ok: true } as HealthCheckResponse;
    },
  };
}

export default createSchedulerExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createSchedulerExtension);
