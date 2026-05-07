import { cloneElement, isValidElement } from "react";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { getToolBadgeConfig } from "./toolConfig";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { useGatewayClient } from "../../hooks/useGatewayClient";

/** Strip CWD prefix from a file path to make it shorter.
 *  Falls back to stripping common home-dir prefixes when CWD doesn't match. */
function stripCwdPrefix(path: string, cwd?: string): string {
  // Try exact CWD match first
  if (cwd && path.startsWith(cwd)) {
    const stripped = path.slice(cwd.length).replace(/^\/+/, "");
    if (stripped) return stripped;
  }

  // Fallback: strip ~/Projects/*/ or ~/*/  to keep paths short
  const homeMatch = path.match(/^\/Users\/[^/]+\/(?:Projects\/)?[^/]+\/(.+)$/);
  if (homeMatch) return homeMatch[1];

  return path;
}

interface ToolHeaderProps {
  toolName: string;
  label: string;
  /** When true, the tool icon is replaced in place with a spinner — so the
   *  user sees activity at the start of the row rather than at the far right. */
  isLoading?: boolean;
}

/** Icon + label header for a tool, using the unified color config */
export function ToolHeader({ toolName, label, isLoading = false }: ToolHeaderProps) {
  const config = getToolBadgeConfig(toolName);

  // Resize icon from size-2.5 (badge) to size-3 (header) for readability
  let displayIcon = config.icon;
  if (isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existing = (element.props as { className?: string })?.className || "";
    const resized = existing ? existing.replace(/size-\d+(\.\d+)?/g, "size-3") : "size-3";
    displayIcon = cloneElement(element, { className: resized });
  }

  return (
    <div className={`flex min-w-0 items-center gap-1.5 text-sm font-medium ${config.colors.text}`}>
      {(isLoading || displayIcon) && (
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center ${config.colors.iconColor}`}
        >
          {isLoading ? <Loader2 className="size-3 animate-spin" /> : displayIcon}
        </span>
      )}
      <span className="min-w-0 truncate tracking-tight">{label}</span>
    </div>
  );
}

/** Monospace text */
export function MonoText({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <code
      title={title}
      className={`font-mono text-sm tracking-tight text-neutral-800 ${className}`}
    >
      {children}
    </code>
  );
}

/**
 * File path pill — clickable to open in code-server via the editor extension.
 *
 * Click → `editor.open_file({ path, line? })`. If the bridge isn't connected
 * the call rejects and we log to console; we don't disable the button or
 * surface a toast since the bridge's presence is invisible to the user (and
 * a missing bridge is fine — they can still read the path).
 */
export function FilePath({
  path,
  line,
  cwd: explicitCwd,
}: {
  path: string;
  /** 1-indexed line to jump to when opened. */
  line?: number;
  cwd?: string;
}) {
  const workspace = useWorkspace();
  const { call } = useGatewayClient();
  const cwd = explicitCwd || workspace.cwd;
  const displayPath = stripCwdPrefix(path, cwd);

  const handleClick = () => {
    const params: Record<string, unknown> = { path };
    if (line !== undefined) params.line = line;
    void call("editor.open_file", params).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[FilePath] editor.open_file failed: ${message}`);
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={line ? `${path}:${line}` : path}
      className="block w-full cursor-pointer rounded border border-neutral-200/50 bg-neutral-50/50 px-1.5 py-0.5 text-left font-mono text-sm break-all tracking-tight text-neutral-800 transition-colors hover:border-neutral-300/70 hover:bg-neutral-200/60"
    >
      {displayPath}
    </button>
  );
}

/** Inline code pill */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <MonoText className="rounded border border-neutral-200/50 bg-neutral-50/50 px-1.5 py-0.5">
      {children}
    </MonoText>
  );
}

/** Scrollable result block */
export function ResultBlock({
  content,
  isError,
  maxHeight = "max-h-72",
}: {
  content: string;
  isError?: boolean;
  maxHeight?: string;
}) {
  const bg = isError ? "bg-red-100/50" : "bg-neutral-100/50";
  const text = isError ? "text-red-700" : "text-neutral-600";

  return (
    <pre
      className={`${maxHeight} overflow-x-hidden rounded ${bg} px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap ${text}`}
    >
      {content}
    </pre>
  );
}
