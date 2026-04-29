import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { SubagentInfo } from "../hooks/useChatGateway";

interface SubagentActivityStripProps {
  subagents: SubagentInfo[];
}

function shortSubagentId(subagentId: string): string {
  return subagentId.length > 16 ? `${subagentId.slice(0, 16)}...` : subagentId;
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

function statusLabel(status: SubagentInfo["status"]): string {
  if (status === "running") return "Busy";
  if (status === "completed") return "Done";
  if (status === "interrupted") return "Stopped";
  return "Failed";
}

function statusClasses(status: SubagentInfo["status"]): string {
  if (status === "running") {
    return "bg-orange-500";
  }
  if (status === "failed") {
    return "bg-red-500";
  }
  return "bg-emerald-500";
}

export function SubagentActivityStrip({ subagents }: SubagentActivityStripProps) {
  const [expandedSubagentId, setExpandedSubagentId] = useState<string | null>(null);
  const visibleSubagents = useMemo(() => subagents.slice(0, 5), [subagents]);
  const hiddenCount = Math.max(0, subagents.length - visibleSubagents.length);

  if (subagents.length === 0) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/70 px-3 py-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-xs font-medium text-zinc-400">Subagents</p>
        {hiddenCount > 0 && <p className="text-xs text-zinc-500">+{hiddenCount} more</p>}
      </div>
      <div className="space-y-2">
        {visibleSubagents.map((subagent) => {
          const expanded = expandedSubagentId === subagent.subagentId;
          const preview =
            subagent.previewText || subagent.error || subagent.prompt || "Waiting for output...";
          return (
            <div
              key={subagent.subagentId}
              className="rounded-lg border border-zinc-800 bg-zinc-900/80"
            >
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-zinc-800/50 transition-colors"
                onClick={() =>
                  setExpandedSubagentId((prev) =>
                    prev === subagent.subagentId ? null : subagent.subagentId,
                  )
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusClasses(subagent.status)} ${
                      subagent.status === "running" ? "animate-pulse" : ""
                    }`}
                  />
                  <span className="text-xs font-medium text-zinc-100">
                    {shortSubagentId(subagent.subagentId)}
                  </span>
                  <span className="text-xs text-zinc-400">{subagent.agent}</span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                    {subagent.purpose}
                  </span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-400">
                    {statusLabel(subagent.status)}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {formatAgo(subagent.updatedAt || subagent.startedAt)}
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
                  {subagent.prompt && (
                    <p className="mb-2 line-clamp-3 text-zinc-400">
                      Prompt: <span className="text-zinc-200">{subagent.prompt}</span>
                    </p>
                  )}
                  {subagent.previewText && (
                    <p className="mb-2 whitespace-pre-wrap break-words text-zinc-200">
                      {subagent.previewText}
                    </p>
                  )}
                  {subagent.cwd && (
                    <p className="truncate text-zinc-500">
                      CWD: <span className="text-zinc-300">{subagent.cwd}</span>
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
