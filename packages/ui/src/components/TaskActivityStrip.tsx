import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { TaskInfo } from "../hooks/useChatGateway";

interface TaskActivityStripProps {
  tasks: TaskInfo[];
}

function shortTaskId(taskId: string): string {
  return taskId.length > 16 ? `${taskId.slice(0, 16)}...` : taskId;
}

function formatAgo(value?: string): string {
  if (!value) return "now";
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return "now";
  const elapsedSec = Math.floor(elapsedMs / 1_000);
  if (elapsedSec < 60) return `${elapsedSec}s ago`;
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin}m ago`;
  const elapsedHr = Math.floor(elapsedMin / 60);
  if (elapsedHr < 24) return `${elapsedHr}h ago`;
  const elapsedDay = Math.floor(elapsedHr / 24);
  return `${elapsedDay}d ago`;
}

function statusLabel(status: TaskInfo["status"]): string {
  if (status === "running") return "Busy";
  if (status === "completed") return "Done";
  if (status === "interrupted") return "Stopped";
  return "Failed";
}

function statusClasses(status: TaskInfo["status"]): string {
  if (status === "running") {
    return "bg-orange-500";
  }
  if (status === "failed") {
    return "bg-red-500";
  }
  return "bg-emerald-500";
}

export function TaskActivityStrip({ tasks }: TaskActivityStripProps) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const visibleTasks = useMemo(() => tasks.slice(0, 5), [tasks]);
  const hiddenCount = Math.max(0, tasks.length - visibleTasks.length);

  if (tasks.length === 0) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/70 px-3 py-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-xs font-medium text-zinc-400">Tasks</p>
        {hiddenCount > 0 && <p className="text-xs text-zinc-500">+{hiddenCount} more</p>}
      </div>
      <div className="space-y-2">
        {visibleTasks.map((task) => {
          const expanded = expandedTaskId === task.taskId;
          const preview = task.previewText || task.error || task.prompt || "Waiting for output...";
          return (
            <div key={task.taskId} className="rounded-lg border border-zinc-800 bg-zinc-900/80">
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-zinc-800/50 transition-colors"
                onClick={() =>
                  setExpandedTaskId((prev) => (prev === task.taskId ? null : task.taskId))
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusClasses(task.status)} ${
                      task.status === "running" ? "animate-pulse" : ""
                    }`}
                  />
                  <span className="text-xs font-medium text-zinc-100">
                    {shortTaskId(task.taskId)}
                  </span>
                  <span className="text-xs text-zinc-400">{task.agent}</span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                    {task.mode}
                  </span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-400">
                    {statusLabel(task.status)}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {formatAgo(task.updatedAt || task.startedAt)}
                  </span>
                  {expanded ? (
                    <ChevronUp className="h-3.5 w-3.5 text-zinc-500" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-zinc-300">{preview}</p>
              </button>
              {expanded && (
                <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-300">
                  {task.prompt && (
                    <p className="mb-2 line-clamp-3 text-zinc-400">
                      Prompt: <span className="text-zinc-200">{task.prompt}</span>
                    </p>
                  )}
                  {task.previewText && (
                    <p className="mb-2 whitespace-pre-wrap break-words text-zinc-200">
                      {task.previewText}
                    </p>
                  )}
                  {task.outputFile && (
                    <p className="truncate text-zinc-400">
                      Output: <span className="text-zinc-200">{task.outputFile}</span>
                    </p>
                  )}
                  {task.cwd && (
                    <p className="truncate text-zinc-500">
                      CWD: <span className="text-zinc-300">{task.cwd}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
