/**
 * Scheduler Page — Task management GUI
 *
 * Lists all scheduled tasks with type badges, countdown timers,
 * execution history, and controls for add/edit/fire/cancel.
 */

import { useState, useEffect, useCallback } from "react";
import { useGatewayClient } from "@anima/ui";

// ── Types ────────────────────────────────────────────────────

interface TaskAction {
  type: "emit" | "extension_call" | "notification";
  target: string;
  payload?: Record<string, unknown>;
}

interface Task {
  id: string;
  name: string;
  description?: string;
  type: "once" | "interval" | "cron";
  fireAt: string;
  cronExpr?: string;
  cronDescription?: string;
  enabled: boolean;
  firedCount: number;
  lastFiredAt?: string;
  action: TaskAction;
  missedPolicy?: string;
  concurrency?: string;
  tags?: string[];
  createdAt: string;
}

interface Execution {
  id: string;
  firedAt: string;
  completedAt?: string;
  status: "running" | "success" | "error" | "skipped" | "cancelled";
  durationMs?: number;
  error?: string;
  output?: string;
}

// ── Helpers ──────────────────────────────────────────────────

function formatCountdown(fireAt: string): string {
  const diff = new Date(fireAt).getTime() - Date.now();
  if (diff <= 0) return "overdue";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  once: { label: "once", color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  interval: { label: "interval", color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  cron: { label: "cron", color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
};

const STATUS_ICONS: Record<string, string> = {
  success: "✅",
  error: "❌",
  skipped: "⏭️",
  running: "⏳",
  cancelled: "🚫",
};

// ── Add Task Form ────────────────────────────────────────────

type ActionType = "notification" | "extension_call" | "emit" | "exec";

interface AddTaskFormProps {
  onSubmit: (task: Record<string, unknown>) => void;
  onCancel: () => void;
}

function AddTaskForm({ onSubmit, onCancel }: AddTaskFormProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"once" | "interval" | "cron">("once");
  const [delayMinutes, setDelayMinutes] = useState(10);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [actionType, setActionType] = useState<ActionType>("notification");
  const [actionTarget, setActionTarget] = useState("");
  const [execArgs, setExecArgs] = useState("");
  const [execShell, setExecShell] = useState(false);
  const [execCwd, setExecCwd] = useState("");
  const [missedPolicy, setMissedPolicy] = useState("fire_once");
  const [tags, setTags] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const actionPayload: Record<string, unknown> = {};
    if (actionType === "exec") {
      if (execArgs.trim()) actionPayload.args = execArgs.split(" ");
      if (execShell) actionPayload.shell = true;
      if (execCwd.trim()) actionPayload.cwd = execCwd;
    }
    const task: Record<string, unknown> = {
      name: name || `${type} task`,
      type,
      action: {
        type: actionType,
        target: actionTarget,
        ...(Object.keys(actionPayload).length > 0 ? { payload: actionPayload } : {}),
      },
      missedPolicy,
      ...(tags.trim() ? { tags: tags.split(",").map((t) => t.trim()) } : {}),
    };

    if (type === "once") {
      task.delaySeconds = delayMinutes * 60;
    } else if (type === "interval") {
      task.delaySeconds = 0;
      task.intervalSeconds = intervalMinutes * 60;
    } else if (type === "cron") {
      task.cronExpr = cronExpr;
    }

    onSubmit(task);
  }

  const CRON_PRESETS = [
    { label: "Every 5 min", expr: "*/5 * * * *" },
    { label: "Every 15 min", expr: "*/15 * * * *" },
    { label: "Every hour", expr: "0 * * * *" },
    { label: "Every 6 hours", expr: "0 */6 * * *" },
    { label: "Daily 9 AM", expr: "0 9 * * *" },
    { label: "Weekdays 9 AM", expr: "0 9 * * 1-5" },
  ];

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-zinc-700/50 bg-zinc-800/50 p-5 space-y-4"
    >
      <h3 className="text-sm font-medium text-zinc-200">New Task</h3>

      {/* Name */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My task"
          className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
        />
      </div>

      {/* Type */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Type</label>
        <div className="flex gap-2">
          {(["once", "interval", "cron"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                type === t
                  ? TYPE_BADGES[t].color
                  : "border-zinc-700 text-zinc-400 hover:text-zinc-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Schedule config */}
      {type === "once" && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Delay (minutes)</label>
          <input
            type="number"
            min={1}
            value={delayMinutes}
            onChange={(e) => setDelayMinutes(Number(e.target.value))}
            className="w-24 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
          />
        </div>
      )}

      {type === "interval" && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Interval (minutes)</label>
          <input
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            className="w-24 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
          />
        </div>
      )}

      {type === "cron" && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Cron Expression</label>
          <input
            type="text"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-purple-500"
          />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.expr}
                type="button"
                onClick={() => setCronExpr(p.expr)}
                className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                  cronExpr === p.expr
                    ? "border-emerald-500/50 text-emerald-300 bg-emerald-500/10"
                    : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Action</label>
        <div className="flex gap-2 mb-2">
          {(["notification", "extension_call", "emit", "exec"] as const).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setActionType(a)}
              className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                actionType === a
                  ? "border-purple-500/50 text-purple-300 bg-purple-500/10"
                  : "border-zinc-700 text-zinc-400 hover:text-zinc-300"
              }`}
            >
              {a === "extension_call" ? "method call" : a === "exec" ? "command" : a}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={actionTarget}
          onChange={(e) => setActionTarget(e.target.value)}
          placeholder={
            actionType === "notification"
              ? "Notification message..."
              : actionType === "extension_call"
                ? "voice.speak"
                : actionType === "exec"
                  ? "/usr/bin/sqlite3"
                  : "event.name"
          }
          className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
        />
      </div>

      {/* Exec options */}
      {actionType === "exec" && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Arguments (space-separated)</label>
            <input
              type="text"
              value={execArgs}
              onChange={(e) => setExecArgs(e.target.value)}
              placeholder="~/.anima/anima.db .backup ~/.anima/backups/anima.db"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-purple-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Working directory (optional)</label>
            <input
              type="text"
              value={execCwd}
              onChange={(e) => setExecCwd(e.target.value)}
              placeholder="/Users/michael/.anima"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-purple-500"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={execShell}
              onChange={(e) => setExecShell(e.target.checked)}
              className="rounded border-zinc-600"
            />
            Run through shell (sh -c) — enables pipes, globs, $(date)
          </label>
        </div>
      )}

      {/* Missed policy (cron only) */}
      {type === "cron" && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Missed Policy</label>
          <select
            value={missedPolicy}
            onChange={(e) => setMissedPolicy(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
          >
            <option value="fire_once">Fire once on catchup</option>
            <option value="skip">Skip if missed</option>
            <option value="fire_all">Fire all missed</option>
          </select>
        </div>
      )}

      {/* Tags */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Tags (comma-separated)</label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="voice, maintenance"
          className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
        />
      </div>

      {/* Submit */}
      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={!actionTarget.trim()}
          className="px-4 py-2 rounded-md text-sm font-medium bg-purple-600 text-white hover:bg-purple-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Schedule Task
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-md text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Task Card ────────────────────────────────────────────────

interface TaskCardProps {
  task: Task;
  onFire: (id: string) => void;
  onCancel: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onViewHistory: (id: string) => void;
}

function TaskCard({ task, onFire, onCancel, onToggle, onViewHistory }: TaskCardProps) {
  const [countdown, setCountdown] = useState(formatCountdown(task.fireAt));
  const badge = TYPE_BADGES[task.type];

  useEffect(() => {
    const interval = setInterval(() => setCountdown(formatCountdown(task.fireAt)), 1000);
    return () => clearInterval(interval);
  }, [task.fireAt]);

  return (
    <div
      className={`rounded-xl border bg-zinc-800/50 p-4 transition-colors ${
        task.enabled ? "border-zinc-700/50" : "border-zinc-800 opacity-50"
      }`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium border ${badge.color}`}
          >
            {badge.label}
          </span>
          <h3 className="text-sm font-medium text-zinc-200 truncate">{task.name}</h3>
        </div>

        {/* Countdown */}
        <div className="shrink-0 flex items-center gap-1.5 text-xs">
          {task.enabled ? (
            <>
              <span className="text-zinc-500">⏱</span>
              <span className={countdown === "overdue" ? "text-amber-400" : "text-zinc-300"}>
                {countdown}
              </span>
            </>
          ) : (
            <span className="text-zinc-600">disabled</span>
          )}
        </div>
      </div>

      {/* Schedule info */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        {task.cronExpr && <span className="font-mono">{task.cronExpr}</span>}
        {task.cronDescription && <span>· {task.cronDescription}</span>}
        {task.type === "interval" && <span>Next: {formatTime(task.fireAt)}</span>}
        {task.type === "once" && <span>{formatTime(task.fireAt)}</span>}
        {task.tags && task.tags.length > 0 && (
          <span>
            {task.tags.map((t) => (
              <span
                key={t}
                className="inline-block mr-1 px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400"
              >
                {t}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Action info */}
      <div className="mt-2 text-xs text-zinc-500">
        <span className="text-zinc-600">{task.action.type}:</span>{" "}
        <span className="text-zinc-400">{task.action.target}</span>
        {task.firedCount > 0 && <span className="ml-2">· fired {task.firedCount}×</span>}
        {task.lastFiredAt && <span className="ml-1">· last {formatTime(task.lastFiredAt)}</span>}
      </div>

      {/* Actions row */}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onFire(task.id)}
          className="text-xs px-2.5 py-1 rounded-md bg-zinc-700/50 text-zinc-300 hover:bg-zinc-600/50 transition-colors"
        >
          Fire Now
        </button>
        <button
          onClick={() => onViewHistory(task.id)}
          className="text-xs px-2.5 py-1 rounded-md bg-zinc-700/50 text-zinc-300 hover:bg-zinc-600/50 transition-colors"
        >
          History
        </button>
        <button
          onClick={() => onToggle(task.id, !task.enabled)}
          className="text-xs px-2.5 py-1 rounded-md bg-zinc-700/50 text-zinc-300 hover:bg-zinc-600/50 transition-colors"
        >
          {task.enabled ? "Disable" : "Enable"}
        </button>
        <button
          onClick={() => onCancel(task.id)}
          className="text-xs px-2.5 py-1 rounded-md bg-red-900/30 text-red-300 hover:bg-red-800/40 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── History Panel ────────────────────────────────────────────

interface HistoryPanelProps {
  taskId: string;
  taskName: string;
  executions: Execution[];
  onClose: () => void;
}

function HistoryPanel({ taskName, executions, onClose }: HistoryPanelProps) {
  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/50 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-zinc-200">History — {taskName}</h3>
        <button
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          ✕ Close
        </button>
      </div>

      {executions.length === 0 ? (
        <p className="text-xs text-zinc-500">No executions yet.</p>
      ) : (
        <div className="space-y-1">
          {executions.map((exec) => (
            <div
              key={exec.id}
              className="flex items-center gap-3 text-xs py-1.5 border-b border-zinc-800 last:border-0"
            >
              <span className="w-5 text-center">{STATUS_ICONS[exec.status] || "?"}</span>
              <span className="text-zinc-400 w-36">{formatTime(exec.firedAt)}</span>
              <span className="text-zinc-500 w-16 text-right">
                {exec.durationMs != null ? formatDuration(exec.durationMs) : "—"}
              </span>
              <span
                className={`${
                  exec.status === "success"
                    ? "text-emerald-400"
                    : exec.status === "error"
                      ? "text-red-400"
                      : exec.status === "skipped"
                        ? "text-amber-400"
                        : "text-zinc-400"
                }`}
              >
                {exec.status}
              </span>
              {exec.error && <span className="text-red-400/70 truncate ml-2">{exec.error}</span>}
              {exec.output && (
                <details className="ml-2">
                  <summary className="text-zinc-500 cursor-pointer hover:text-zinc-400">
                    output
                  </summary>
                  <pre className="mt-1 p-2 bg-zinc-900 rounded text-xs text-zinc-400 whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {exec.output}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────

export function SchedulerPage() {
  const { call } = useGatewayClient();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [historyView, setHistoryView] = useState<{
    taskId: string;
    taskName: string;
    executions: Execution[];
  } | null>(null);

  const rpc = useCallback(
    <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
      call<T>(method, params, { timeoutMs: 10000 }),
    [call],
  );

  const loadTasks = useCallback(async () => {
    try {
      const result = await rpc<{ tasks: Task[] }>("scheduler.list_tasks");
      setTasks(result.tasks);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    loadTasks();
    const interval = setInterval(loadTasks, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [loadTasks]);

  async function handleAddTask(taskData: Record<string, unknown>) {
    await rpc("scheduler.add_task", taskData);
    setShowAddForm(false);
    loadTasks();
  }

  async function handleFire(taskId: string) {
    await rpc("scheduler.fire_now", { taskId });
    loadTasks();
  }

  async function handleCancel(taskId: string) {
    await rpc("scheduler.cancel_task", { taskId });
    loadTasks();
  }

  async function handleToggle(taskId: string, enabled: boolean) {
    await rpc("scheduler.update_task", { taskId, enabled });
    loadTasks();
  }

  async function handleViewHistory(taskId: string) {
    const result = await rpc<{
      taskId: string;
      taskName: string;
      executions: Execution[];
    }>("scheduler.get_history", { taskId, limit: 20 });
    setHistoryView(result);
  }

  // Group tasks: cron first, then interval, then once
  const sortedTasks = [...tasks].sort((a, b) => {
    const typeOrder = { cron: 0, interval: 1, once: 2 };
    const orderDiff = typeOrder[a.type] - typeOrder[b.type];
    if (orderDiff !== 0) return orderDiff;
    // Within same type, enabled first
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime();
  });

  const cronCount = tasks.filter((t) => t.type === "cron").length;
  const onceCount = tasks.filter((t) => t.type === "once").length;
  const intervalCount = tasks.filter((t) => t.type === "interval").length;

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Scheduler</h1>
            <p className="text-xs text-zinc-500 mt-1">
              {tasks.length} task{tasks.length !== 1 ? "s" : ""}
              {cronCount > 0 && ` · ${cronCount} cron`}
              {intervalCount > 0 && ` · ${intervalCount} interval`}
              {onceCount > 0 && ` · ${onceCount} one-shot`}
            </p>
          </div>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-4 py-2 rounded-md text-sm font-medium bg-purple-600 text-white hover:bg-purple-500 transition-colors"
          >
            {showAddForm ? "Cancel" : "+ Add Task"}
          </button>
        </div>

        {/* Add form */}
        {showAddForm && (
          <div className="mb-6">
            <AddTaskForm onSubmit={handleAddTask} onCancel={() => setShowAddForm(false)} />
          </div>
        )}

        {/* History panel */}
        {historyView && (
          <div className="mb-6">
            <HistoryPanel
              taskId={historyView.taskId}
              taskName={historyView.taskName}
              executions={historyView.executions}
              onClose={() => setHistoryView(null)}
            />
          </div>
        )}

        {/* Task list */}
        {loading ? (
          <div className="text-center text-sm text-zinc-500 py-12">Loading tasks...</div>
        ) : sortedTasks.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-zinc-500">No scheduled tasks.</p>
            <p className="text-xs text-zinc-600 mt-1">
              Click "+ Add Task" to create one, or use the CLI.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onFire={handleFire}
                onCancel={handleCancel}
                onToggle={handleToggle}
                onViewHistory={handleViewHistory}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
