#!/usr/bin/env bun
/**
 * Scheduler Extension — Autonomous Task Scheduling
 *
 * Durable task scheduling with SQLite persistence and execution history.
 * Tasks survive gateway restarts. A 5-second check loop fires due tasks
 * and emits events through the gateway event bus.
 *
 * Task types:
 *   - "once"     — Fire at a specific ISO timestamp (or delay from now)
 *   - "interval" — Fire every N seconds (e.g. "300" for 5 minutes)
 *   - "cron"     — Fire on cron schedule ("0 9 * * 1-5" for weekdays at 9 AM)
 *
 * Actions:
 *   - "emit"           — Emit a gateway event with payload
 *   - "extension_call" — Call an extension method via ctx.call()
 *   - "notification"   — Emit scheduler.notification event (convenience)
 *   - "exec"           — Spawn a shell command (target = binary, payload.args/shell/cwd/timeoutMs)
 *
 * Policies (cron tasks):
 *   - missedPolicy:  "fire_once" | "skip" | "fire_all"
 *   - concurrency:   "allow" | "skip_if_running" | "cancel_previous"
 */

import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  type LegacyTask,
  type ScheduledTask,
  closeDb,
  completeExecution,
  deleteTask,
  getAllTasks,
  getEnabledDueTasks,
  getExecutionsForTask,
  getLatestRunningExecution,
  getTaskById,
  insertExecution,
  insertTask,
  migrateLegacyTasks,
  pruneExecutions,
  setTaskEnabled,
  updateExecutionProgress,
  updateTask,
  updateTaskAfterFire,
} from "./db.js";
import { cronParser } from "./cronParser.js";
import { interpolate, interpolateAll } from "./template.js";

// ── JSON migration ──────────────────────────────────────────

const LEGACY_STORE_PATH = join(homedir(), ".anima", "scheduled-tasks.json");

function migrateLegacyJsonStore(log: ExtensionContext["log"]): void {
  if (!existsSync(LEGACY_STORE_PATH)) return;

  try {
    const raw = readFileSync(LEGACY_STORE_PATH, "utf-8");
    const store = JSON.parse(raw) as { tasks: LegacyTask[] };

    if (store.tasks.length > 0) {
      const count = migrateLegacyTasks(store.tasks);
      log.info(`Migrated ${count} task(s) from JSON to SQLite`);
    }

    // Rename so we don't migrate again
    renameSync(LEGACY_STORE_PATH, LEGACY_STORE_PATH + ".migrated");
    log.info("Renamed scheduled-tasks.json → scheduled-tasks.json.migrated");
  } catch (error) {
    log.error("Failed to migrate legacy JSON tasks", { error: String(error) });
  }
}

// ── Catchup logic ───────────────────────────────────────────

function handleMissedTasks(log: ExtensionContext["log"]): { catchup: ScheduledTask[] } {
  const now = new Date();
  const nowIso = now.toISOString();
  const dueTasks = getEnabledDueTasks(nowIso);
  const catchup: ScheduledTask[] = [];

  for (const task of dueTasks) {
    if (task.type !== "cron") {
      // Once/interval tasks always fire when due — no policy needed
      catchup.push(task);
      continue;
    }

    const missedBy = now.getTime() - new Date(task.fireAt).getTime();
    const deadlineMs = (task.startDeadlineSeconds ?? 3600) * 1000;

    if (missedBy > deadlineMs) {
      // Missed by too long — skip regardless of policy
      log.info(`Skipping missed cron task (past deadline): ${task.name}`, {
        id: task.id,
        missedByMs: missedBy,
      });
      insertExecution({
        id: crypto.randomUUID(),
        taskId: task.id,
        firedAt: nowIso,
        status: "skipped",
      });
      // Advance to next cron occurrence
      const nextFire = cronParser.getNextRun(task.cronExpr!, now);
      if (nextFire) {
        updateTaskAfterFire(task.id, nextFire, task.firedCount, nowIso);
      }
      continue;
    }

    switch (task.missedPolicy) {
      case "skip":
        log.info(`Skipping missed cron task (policy=skip): ${task.name}`, { id: task.id });
        insertExecution({
          id: crypto.randomUUID(),
          taskId: task.id,
          firedAt: nowIso,
          status: "skipped",
        });
        // Advance to next occurrence
        {
          const nextFire = cronParser.getNextRun(task.cronExpr!, now);
          if (nextFire) {
            updateTaskAfterFire(task.id, nextFire, task.firedCount, nowIso);
          }
        }
        break;

      case "fire_once":
        log.info(`Catchup firing missed cron task (policy=fire_once): ${task.name}`, {
          id: task.id,
        });
        catchup.push(task);
        break;

      case "fire_all":
        // For fire_all, we still just fire once — we don't queue N missed runs
        // The distinction matters for history (all intervals are logged as skipped except last)
        log.info(`Catchup firing missed cron task (policy=fire_all): ${task.name}`, {
          id: task.id,
        });
        catchup.push(task);
        break;
    }
  }

  return { catchup };
}

// ── Extension Factory ────────────────────────────────────────

export function createSchedulerExtension(_config: Record<string, unknown> = {}): AnimaExtension {
  let ctx: ExtensionContext | null = null;
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  const CHECK_INTERVAL_MS = 5_000;

  // Track running tasks for concurrency control
  const runningTasks = new Set<string>();

  // ── Fire a single task ─────────────────────────────────────

  async function fireTask(task: ScheduledTask): Promise<void> {
    if (!ctx) return;
    const taskLog = ctx.createLogger({
      component: `task:${task.id.slice(0, 8)}`,
      fileName: `scheduler-task-${task.id}.log`,
    });

    // Concurrency check
    if (task.concurrency === "skip_if_running" && runningTasks.has(task.id)) {
      ctx.log.info(`Skipping task (already running): ${task.name}`, { id: task.id });
      insertExecution({
        id: crypto.randomUUID(),
        taskId: task.id,
        firedAt: new Date().toISOString(),
        status: "skipped",
      });
      return;
    }

    const execId = crypto.randomUUID();
    const firedAt = new Date().toISOString();
    const startMs = performance.now();

    runningTasks.add(task.id);
    insertExecution({ id: execId, taskId: task.id, firedAt, status: "running" });

    ctx.log.info(`Firing scheduled task: ${task.name}`, {
      id: task.id,
      actionType: task.action.type,
    });

    let execOutput: string | undefined;

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
            message: interpolate(task.action.target, task),
            ...task.action.payload,
          });
          break;

        case "extension_call":
          await ctx.call(task.action.target, task.action.payload ?? {});
          break;

        case "exec": {
          const payload = task.action.payload ?? {};
          const rawArgs = (payload.args as string[]) ?? [];
          const useShell = (payload.shell as boolean) ?? false;
          const rawCwd = (payload.cwd as string) ?? undefined;
          const timeoutMs = (payload.timeoutMs as number) ?? 60_000;
          const customEnv = (payload.env as Record<string, string>) ?? {};

          // Interpolate template variables in command, args, and cwd
          const target = interpolate(task.action.target, task);
          const args = interpolateAll(rawArgs, task);
          const cwd = rawCwd ? interpolate(rawCwd, task) : undefined;

          const cmd = useShell ? ["sh", "-c", [target, ...args].join(" ")] : [target, ...args];

          // Merge env: parent process env + custom payload env + auto-injected anima vars
          const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            ...customEnv,
            ANIMA_TASK_ID: task.id,
            ANIMA_EXECUTION_ID: execId,
          };

          ctx.log.info(`Exec task started: ${task.name}`, { id: task.id, cwd, timeoutMs });
          taskLog.info("Exec command", {
            command: cmd.join(" "),
            cwd,
            timeoutMs,
            execId,
          });

          const proc = Bun.spawn(cmd, {
            cwd,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });

          // Race against timeout
          const timeoutPromise = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), timeoutMs),
          );
          const exitPromise = proc.exited.then((code) => ({ code }));
          const result = await Promise.race([exitPromise, timeoutPromise]);

          if (result === "timeout") {
            proc.kill();
            throw new Error(`Process timed out after ${timeoutMs}ms`);
          }

          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = result.code;

          // Capture output for execution history (truncate to 4KB)
          const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n---\n");
          if (combined) execOutput = combined.slice(0, 4096);

          if (exitCode !== 0) {
            throw new Error(
              `Process exited with code ${exitCode}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
            );
          }

          if (stdout.trim()) taskLog.info("exec stdout", { text: stdout.trim().slice(0, 4000) });
          if (stderr.trim()) taskLog.warn("exec stderr", { text: stderr.trim().slice(0, 4000) });
          break;
        }
      }

      const durationMs = Math.round(performance.now() - startMs);
      completeExecution(execId, "success", durationMs, undefined, execOutput);
      ctx.log.info(`Scheduled task completed: ${task.name}`, {
        id: task.id,
        durationMs,
        status: "success",
      });
      taskLog.info("Task completed", {
        durationMs,
        status: "success",
      });

      // Emit generic task_fired event
      ctx.emit("scheduler.task_fired", {
        taskId: task.id,
        taskName: task.name,
        action: task.action,
        firedAt,
        durationMs,
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - startMs);
      completeExecution(execId, "error", durationMs, String(error));
      ctx.log.error(`Failed to fire task: ${task.name}`, { id: task.id, error: String(error) });
      taskLog.error("Task failed", { durationMs, error: String(error) });
    } finally {
      runningTasks.delete(task.id);
    }

    // Update task state
    const now = new Date();
    const newFiredCount = task.firedCount + 1;

    if (task.type === "once") {
      // Disable instead of delete so the task and its execution history remain
      // inspectable via scheduler.get_history and `anima skill task <id>`.
      // UI surfaces should filter out type:once + enabled:false unless explicitly
      // requested, and a future cleanup pass can prune by age.
      updateTaskAfterFire(task.id, task.fireAt, newFiredCount, firedAt);
      setTaskEnabled(task.id, false);
    } else if (task.type === "interval" && task.intervalSeconds) {
      const nextFire = new Date(now.getTime() + task.intervalSeconds * 1000).toISOString();
      updateTaskAfterFire(task.id, nextFire, newFiredCount, firedAt);
    } else if (task.type === "cron" && task.cronExpr) {
      const nextFire = cronParser.getNextRun(task.cronExpr, now);
      if (nextFire) {
        updateTaskAfterFire(task.id, nextFire, newFiredCount, firedAt);
      } else {
        ctx.log.warn(`No next cron run found for task: ${task.name}`, { id: task.id });
        setTaskEnabled(task.id, false);
      }
    }

    // Prune old execution history
    pruneExecutions(task.id, task.keepHistory);
  }

  // ── Task check loop ────────────────────────────────────────

  async function checkAndFireTasks(): Promise<void> {
    if (!ctx) return;

    const nowIso = new Date().toISOString();
    const dueTasks = getEnabledDueTasks(nowIso);

    for (const task of dueTasks) {
      // Type:once tasks stay enabled (and "due") between fire-start and
      // completion. Without this guard the tick loop fires them every 5s and
      // each call records a "skipped" execution row — generating 14+ noise
      // rows for a single 70s run. The original "running" execution already
      // covers the audit trail, so silently skip ticks while the task runs.
      // Cron/interval tasks keep the inner skip-with-record path (see
      // fireTask) because their overlap signal is useful for tuning cadence.
      if (task.type === "once" && runningTasks.has(task.id)) continue;
      await fireTask(task);
    }
  }

  // ── Method definitions ─────────────────────────────────────

  const methods = [
    {
      name: "scheduler.add_task",
      description:
        "Schedule a new task. Use delaySeconds for relative timing, fireAt for absolute, or cronExpr for recurring.",
      inputSchema: z.object({
        name: z.string().describe("Human-readable task name"),
        description: z.string().optional(),
        type: z.enum(["once", "interval", "cron"]).default("once"),
        fireAt: z.string().optional().describe("ISO timestamp when task should fire"),
        delaySeconds: z
          .number()
          .optional()
          .describe("Seconds from now to fire (alternative to fireAt)"),
        intervalSeconds: z
          .number()
          .optional()
          .describe("For interval tasks: repeat every N seconds"),
        cronExpr: z
          .string()
          .optional()
          .describe('For cron tasks: cron expression (e.g. "0 9 * * 1-5")'),
        action: z.object({
          type: z.enum(["emit", "extension_call", "notification", "exec"]).default("notification"),
          target: z.string().describe("Event name, method name, or notification message"),
          payload: z.record(z.string(), z.unknown()).optional(),
        }),
        missedPolicy: z.enum(["fire_once", "skip", "fire_all"]).default("fire_once"),
        concurrency: z
          .enum(["allow", "skip_if_running", "cancel_previous"])
          .default("skip_if_running"),
        startDeadlineSeconds: z
          .number()
          .optional()
          .describe("Skip if missed by more than N seconds"),
        tags: z.array(z.string()).optional().describe("Tags for grouping/filtering"),
        keepHistory: z.number().default(50).describe("Number of executions to retain"),
        outputDir: z
          .string()
          .optional()
          .describe(
            "Output directory pattern for {{task.output_dir}}. Supports template variables. Default: ~/.anima/tasks/<slug>/YYYY/MM/",
          ),
      }),
    },
    {
      name: "scheduler.update_task",
      description: "Update an existing task's configuration",
      inputSchema: z.object({
        taskId: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        cronExpr: z.string().optional(),
        action: z
          .object({
            type: z.enum(["emit", "extension_call", "notification", "exec"]),
            target: z.string(),
            payload: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
        missedPolicy: z.enum(["fire_once", "skip", "fire_all"]).optional(),
        concurrency: z.enum(["allow", "skip_if_running", "cancel_previous"]).optional(),
        startDeadlineSeconds: z.number().optional(),
        tags: z.array(z.string()).optional(),
        keepHistory: z.number().optional(),
        outputDir: z.string().optional(),
        enabled: z.boolean().optional(),
      }),
    },
    {
      name: "scheduler.list_tasks",
      description: "List all scheduled tasks, optionally filtered by type or tags",
      inputSchema: z.object({
        type: z.enum(["once", "interval", "cron"]).optional(),
        tags: z.array(z.string()).optional(),
        enabledOnly: z.boolean().optional(),
      }),
    },
    {
      name: "scheduler.cancel_task",
      description: "Cancel a scheduled task by ID",
      inputSchema: z.object({
        taskId: z.string(),
      }),
    },
    {
      name: "scheduler.fire_now",
      description: "Immediately execute a task (ignoring its schedule)",
      inputSchema: z.object({
        taskId: z.string(),
      }),
    },
    {
      name: "scheduler.get_history",
      description: "Get execution history for a task",
      inputSchema: z.object({
        taskId: z.string(),
        limit: z.number().default(50),
      }),
    },
    {
      name: "scheduler.update_progress",
      description:
        "Update the progress message on a running task execution. taskId is always required (read $ANIMA_TASK_ID inside an exec task). Pass executionId too for precision when multiple executions could be in flight; otherwise the scheduler resolves the latest 'running' execution for the task.",
      inputSchema: z.object({
        taskId: z.string().describe("Task id — required. Read $ANIMA_TASK_ID inside an exec task."),
        executionId: z
          .string()
          .optional()
          .describe(
            "Optional — pin the update to a specific execution. When omitted, " +
              "scheduler picks the latest 'running' execution for the task. Read " +
              "$ANIMA_EXECUTION_ID inside an exec task.",
          ),
        message: z.string().describe("Progress message (e.g. 'Generated part 5 of 9')"),
        meta: z.record(z.string(), z.unknown()).optional().describe("Optional structured data"),
      }),
    },
    {
      name: "scheduler.health_check",
      description: "Return scheduler health and stats",
      inputSchema: z.object({}),
    },
  ];

  // ── Method handlers ────────────────────────────────────────

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
          cronExpr,
          action,
          missedPolicy = "fire_once",
          concurrency = "skip_if_running",
          startDeadlineSeconds,
          tags,
          keepHistory = 50,
          outputDir,
        } = params as {
          name: string;
          description?: string;
          type?: "once" | "interval" | "cron";
          fireAt?: string;
          delaySeconds?: number;
          intervalSeconds?: number;
          cronExpr?: string;
          action: {
            type: "emit" | "extension_call" | "notification" | "exec";
            target: string;
            payload?: Record<string, unknown>;
          };
          missedPolicy?: "fire_once" | "skip" | "fire_all";
          concurrency?: "allow" | "skip_if_running" | "cancel_previous";
          startDeadlineSeconds?: number;
          tags?: string[];
          keepHistory?: number;
          outputDir?: string;
        };

        // Compute fire time
        let computedFireAt: string;
        if (type === "cron") {
          if (!cronExpr) throw new Error("cronExpr is required for cron tasks");
          if (!cronParser.isValid(cronExpr))
            throw new Error(`Invalid cron expression: ${cronExpr}`);
          const nextRun = cronParser.getNextRun(cronExpr);
          if (!nextRun) throw new Error(`No upcoming run found for cron: ${cronExpr}`);
          computedFireAt = nextRun;
        } else if (delaySeconds !== undefined) {
          computedFireAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        } else if (fireAt) {
          computedFireAt = fireAt;
        } else {
          throw new Error("Either fireAt, delaySeconds, or cronExpr is required");
        }

        const task: ScheduledTask = {
          id: crypto.randomUUID(),
          name,
          description,
          type,
          fireAt: computedFireAt,
          intervalSeconds: type === "interval" ? intervalSeconds : undefined,
          cronExpr: type === "cron" ? cronExpr : undefined,
          action,
          missedPolicy,
          concurrency,
          startDeadlineSeconds,
          enabled: true,
          tags,
          createdAt: new Date().toISOString(),
          firedCount: 0,
          keepHistory,
          outputDir,
        };

        insertTask(task);

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
          ...(type === "cron" && cronExpr
            ? { cronDescription: cronParser.describe(cronExpr) }
            : {}),
        };
      }

      case "scheduler.update_task": {
        const { taskId, enabled, action, ...updates } = params as {
          taskId: string;
          enabled?: boolean;
          action?: {
            type: "emit" | "extension_call" | "notification" | "exec";
            target: string;
            payload?: Record<string, unknown>;
          };
          name?: string;
          description?: string;
          cronExpr?: string;
          missedPolicy?: "fire_once" | "skip" | "fire_all";
          concurrency?: "allow" | "skip_if_running" | "cancel_previous";
          startDeadlineSeconds?: number;
          tags?: string[];
          keepHistory?: number;
          outputDir?: string;
        };

        const existing = getTaskById(taskId);
        if (!existing) throw new Error(`Task not found: ${taskId}`);

        // If updating cron expression, recalculate next fire time
        let newFireAt: string | undefined;
        if (updates.cronExpr) {
          if (!cronParser.isValid(updates.cronExpr))
            throw new Error(`Invalid cron expression: ${updates.cronExpr}`);
          const nextRun = cronParser.getNextRun(updates.cronExpr);
          if (nextRun) newFireAt = nextRun;
        }

        updateTask(taskId, {
          ...updates,
          ...(newFireAt ? { fireAt: newFireAt } : {}),
          ...(action ? { action } : {}),
        });
        if (enabled !== undefined) setTaskEnabled(taskId, enabled);

        ctx?.log.info(`Task updated: ${taskId}`);
        return { ok: true, taskId };
      }

      case "scheduler.list_tasks": {
        const {
          type,
          tags: filterTags,
          enabledOnly,
        } = params as {
          type?: string;
          tags?: string[];
          enabledOnly?: boolean;
        };

        let tasks = getAllTasks();

        if (type) tasks = tasks.filter((t) => t.type === type);
        if (enabledOnly) tasks = tasks.filter((t) => t.enabled);
        if (filterTags && filterTags.length > 0) {
          tasks = tasks.filter((t) => t.tags && filterTags.some((ft) => t.tags!.includes(ft)));
        }

        return {
          tasks: tasks.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            type: t.type,
            fireAt: t.fireAt,
            cronExpr: t.cronExpr,
            cronDescription: t.cronExpr ? cronParser.describe(t.cronExpr) : undefined,
            enabled: t.enabled,
            firedCount: t.firedCount,
            lastFiredAt: t.lastFiredAt,
            action: t.action,
            missedPolicy: t.missedPolicy,
            concurrency: t.concurrency,
            tags: t.tags,
            createdAt: t.createdAt,
          })),
          count: tasks.length,
        };
      }

      case "scheduler.cancel_task": {
        const { taskId } = params as { taskId: string };
        const removed = deleteTask(taskId);
        ctx?.log.info(`Task cancelled: ${taskId}`, { removed });
        return { ok: true, taskId, removed };
      }

      case "scheduler.fire_now": {
        const { taskId } = params as { taskId: string };
        const task = getTaskById(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        await fireTask(task);
        return { ok: true, taskId, firedAt: new Date().toISOString() };
      }

      case "scheduler.get_history": {
        const { taskId, limit = 50 } = params as { taskId: string; limit?: number };
        const task = getTaskById(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        const executions = getExecutionsForTask(taskId, limit);
        return {
          taskId,
          taskName: task.name,
          executions: executions.map((e) => ({
            id: e.id,
            firedAt: e.fired_at,
            completedAt: e.completed_at,
            status: e.status,
            durationMs: e.duration_ms,
            error: e.error,
            output: e.output,
            progressMessage: e.progress_message,
          })),
          count: executions.length,
        };
      }

      case "scheduler.update_progress": {
        const { taskId, executionId, message, meta } = params as {
          taskId: string;
          executionId?: string;
          message: string;
          meta?: Record<string, unknown>;
        };

        // taskId is schema-required so it's always present here. executionId
        // is optional precision — when omitted we resolve the latest 'running'
        // execution for the task (the common case for one-shot skill runs).
        let resolvedExecId = executionId;
        if (!resolvedExecId) {
          const exec = getLatestRunningExecution(taskId);
          if (!exec) {
            throw new Error(`No running execution found for task: ${taskId}`);
          }
          resolvedExecId = exec.id;
        }

        const updated = updateExecutionProgress(resolvedExecId!, message);
        if (!updated) {
          throw new Error(`Execution not found: ${resolvedExecId}`);
        }

        // Broadcast a live progress event for any UI surface that wants it
        ctx?.emit("scheduler.task_progress", {
          taskId,
          executionId: resolvedExecId,
          message,
          meta,
          at: new Date().toISOString(),
        });

        return { ok: true, executionId: resolvedExecId, message };
      }

      case "scheduler.health_check": {
        const tasks = getAllTasks();
        const now = Date.now();
        const enabled = tasks.filter((t) => t.enabled);
        const pending = enabled.filter((t) => new Date(t.fireAt).getTime() > now).length;
        const overdue = enabled.filter((t) => new Date(t.fireAt).getTime() <= now).length;
        const cronCount = tasks.filter((t) => t.type === "cron").length;

        return {
          ok: true,
          status: "healthy",
          label: "Scheduler",
          metrics: [
            { label: "Total Tasks", value: tasks.length },
            { label: "Cron Jobs", value: cronCount },
            { label: "Pending", value: pending },
            { label: "Overdue", value: overdue },
          ],
        } satisfies HealthCheckResponse;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ── Extension lifecycle ────────────────────────────────────

  return {
    id: "scheduler",
    name: "Task Scheduler",
    methods,
    events: ["scheduler.task_fired", "scheduler.notification", "scheduler.task_progress"],

    async start(context: ExtensionContext): Promise<void> {
      ctx = context;

      // Tables created by gateway migration 018-scheduler-tables.sql
      ctx.log.info("Scheduler database ready");

      // Migrate legacy JSON store if present
      migrateLegacyJsonStore(ctx.log);

      // Handle missed tasks on startup
      const { catchup } = handleMissedTasks(ctx.log);
      if (catchup.length > 0) {
        ctx.log.info(`Firing ${catchup.length} catchup task(s)`);
        for (const task of catchup) {
          await fireTask(task);
        }
      }

      const tasks = getAllTasks();
      const cronCount = tasks.filter((t) => t.type === "cron").length;
      ctx.log.info(`Scheduler started — ${tasks.length} task(s) loaded (${cronCount} cron)`);

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
      closeDb();
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
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createSchedulerExtension);
