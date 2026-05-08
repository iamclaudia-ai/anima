/**
 * `anima skill task <task-id>` — inspect a queued/running/completed skill task.
 *
 *   anima skill task <id>            → JSON status (latest execution)
 *   anima skill task <id> --watch    → poll until completion
 *   anima skill task <id> --cancel   → delegate to scheduler.cancel_task
 *
 * Thin wrapper over scheduler.get_history + scheduler.list_tasks (for fireAt) +
 * scheduler.cancel_task.
 */

import { createGatewayClient } from "@anima/shared";

export interface TaskCommandOptions {
  taskId: string;
  watch?: boolean;
  cancel?: boolean;
  gatewayUrl: string;
}

interface ExecutionRecord {
  id: string;
  firedAt: string;
  completedAt?: string;
  status: "running" | "success" | "error" | "skipped" | "cancelled";
  durationMs?: number;
  error?: string;
  output?: string;
  progressMessage?: string;
}

interface HistoryResponse {
  taskId: string;
  taskName: string;
  executions: ExecutionRecord[];
  count: number;
}

interface TaskListEntry {
  id: string;
  name: string;
  fireAt: string;
  enabled: boolean;
  firedCount: number;
  lastFiredAt?: string;
}

export async function runSkillTask(opts: TaskCommandOptions): Promise<number> {
  if (opts.cancel) {
    return await cancelTask(opts);
  }
  if (opts.watch) {
    return await watchTask(opts);
  }
  return await showTaskStatus(opts);
}

async function showTaskStatus(opts: TaskCommandOptions): Promise<number> {
  const client = createGatewayClient({ url: opts.gatewayUrl });
  try {
    const status = await fetchTaskStatus(client, opts.taskId);
    console.log(JSON.stringify(status, null, 2));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return 1;
  } finally {
    client.disconnect();
  }
}

async function watchTask(opts: TaskCommandOptions): Promise<number> {
  const client = createGatewayClient({ url: opts.gatewayUrl });
  let lastProgress: string | undefined;
  let lastStatus: string | undefined;

  console.log(`Watching task ${opts.taskId} — Ctrl-C to stop\n`);

  try {
    // Poll every 2s until the task reaches a terminal status
    while (true) {
      let status;
      try {
        status = await fetchTaskStatus(client, opts.taskId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n[lookup failed] ${msg}`);
        return 1;
      }

      // Print progress changes
      if (status.progress && status.progress !== lastProgress) {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] ${status.progress}`);
        lastProgress = status.progress;
      }

      // Print status transitions, except for "skipped" which is just a duplicate-fire
      // marker from the concurrency guard — we keep watching for the actual run.
      if (status.status !== lastStatus && status.status !== "skipped") {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] status → ${status.status}`);
        lastStatus = status.status;
      }

      if (
        status.status === "success" ||
        status.status === "error" ||
        status.status === "cancelled"
      ) {
        console.log("");
        if (status.status === "error" && status.error) {
          console.log(`  error: ${status.error}`);
        }
        if (status.durationMs !== undefined) {
          console.log(`  duration: ${(status.durationMs / 1000).toFixed(1)}s`);
        }
        if (status.output) {
          console.log("\n  --- output (last 4KB) ---");
          console.log(status.output);
        }
        return status.status === "success" ? 0 : 1;
      }

      await Bun.sleep(2000);
    }
  } finally {
    client.disconnect();
  }
}

async function cancelTask(opts: TaskCommandOptions): Promise<number> {
  const client = createGatewayClient({ url: opts.gatewayUrl });
  try {
    const result = (await client.call("scheduler.cancel_task", { taskId: opts.taskId })) as {
      ok: boolean;
      taskId: string;
      removed: number;
    };
    if (result.removed > 0) {
      console.log(`Cancelled task: ${opts.taskId}`);
    } else {
      console.log(`No task found with id: ${opts.taskId}`);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return 1;
  } finally {
    client.disconnect();
  }
}

interface TaskStatusReport {
  taskId: string;
  taskName: string;
  status: "queued" | "running" | "success" | "error" | "skipped" | "cancelled" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  output?: string;
  progress?: string;
  logFile: string;
  fireAt?: string;
  enabled?: boolean;
}

async function fetchTaskStatus(
  client: ReturnType<typeof createGatewayClient>,
  taskId: string,
): Promise<TaskStatusReport> {
  // Pull a small window of recent executions; we'll pick the most relevant.
  const history = (await client.call("scheduler.get_history", {
    taskId,
    limit: 10,
  })) as HistoryResponse;

  // Also pull task-level info to surface fireAt for not-yet-run tasks
  let fireAt: string | undefined;
  let enabled: boolean | undefined;
  try {
    const list = (await client.call("scheduler.list_tasks", {})) as { tasks: TaskListEntry[] };
    const entry = list.tasks.find((t) => t.id === taskId);
    if (entry) {
      fireAt = entry.fireAt;
      enabled = entry.enabled;
    }
  } catch {
    // Non-fatal — task may have completed and been deleted (type=once)
  }

  const logFile = `~/.anima/logs/scheduler-task-${taskId}.log`;

  if (history.executions.length === 0) {
    return {
      taskId,
      taskName: history.taskName,
      status: "queued",
      progress: undefined,
      fireAt,
      enabled,
      logFile,
    };
  }

  // Prefer the most recent execution that represents an actual run.
  // skip_if_running can insert later "skipped" rows while a "running" row is still in flight —
  // we don't want those to mask the live execution.
  const relevant =
    history.executions.find((e) => e.status === "running") ??
    history.executions.find((e) => e.status === "success" || e.status === "error") ??
    history.executions[0]!;

  return {
    taskId,
    taskName: history.taskName,
    status: relevant.status,
    startedAt: relevant.firedAt,
    finishedAt: relevant.completedAt,
    durationMs: relevant.durationMs,
    error: relevant.error,
    output: relevant.output,
    progress: relevant.progressMessage,
    fireAt,
    enabled,
    logFile,
  };
}
