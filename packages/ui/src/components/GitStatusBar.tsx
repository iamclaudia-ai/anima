/**
 * GitStatusBar — Compact strip rendered below the chat input that shows
 * the current git branch, working-tree dirtiness, and any open PR for the
 * branch. Populated by `session.<id>.git_status` events emitted at the
 * end of each agent turn.
 */

import {
  FilePenLine,
  FilePlus,
  FileX,
  FileQuestionMark,
  FilePen,
  CloudUpload,
  CloudDownload,
  Check,
} from "lucide-react";
import type { ComponentType } from "react";
import type { GitStatusInfo } from "../hooks/useChatGateway";

function GitIcon({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="#F05032"
      className={className}
      aria-hidden="true"
    >
      <path d="M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187" />
    </svg>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="#181717"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

interface GitStatusBarProps {
  status: GitStatusInfo | null;
}

export function GitStatusBar({ status }: GitStatusBarProps) {
  if (!status || !status.branch) return null;

  const { branch, ahead, behind, dirty, pr } = status;

  type DirtyBadge = {
    key: string;
    count: number;
    color: string;
    Icon: ComponentType<{ className?: string }>;
    label: string;
  };
  const dirtyBadges: DirtyBadge[] = [];
  if (dirty.added > 0)
    dirtyBadges.push({
      key: "added",
      count: dirty.added,
      color: "text-emerald-600",
      Icon: FilePlus,
      label: "added",
    });
  if (dirty.modified > 0)
    dirtyBadges.push({
      key: "modified",
      count: dirty.modified,
      color: "text-amber-600",
      Icon: FilePenLine,
      label: "modified",
    });
  if (dirty.renamed > 0)
    dirtyBadges.push({
      key: "renamed",
      count: dirty.renamed,
      color: "text-blue-600",
      Icon: FilePen,
      label: "renamed",
    });
  if (dirty.deleted > 0)
    dirtyBadges.push({
      key: "deleted",
      count: dirty.deleted,
      color: "text-red-600",
      Icon: FileX,
      label: "deleted",
    });
  if (dirty.untracked > 0)
    dirtyBadges.push({
      key: "untracked",
      count: dirty.untracked,
      color: "text-purple-600",
      Icon: FileQuestionMark,
      label: "untracked",
    });

  const prStateColor = pr
    ? pr.isDraft
      ? "text-gray-500"
      : pr.state === "MERGED"
        ? "text-purple-600"
        : pr.state === "CLOSED"
          ? "text-red-600"
          : "text-emerald-600"
    : "text-gray-500";

  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3 mt-2 text-sm text-gray-600">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="inline-flex items-center gap-1 font-medium leading-none min-w-0"
          title={`Branch: ${branch}`}
        >
          <GitIcon className="size-4 shrink-0" />
          <span className="font-mono truncate">{branch}</span>
        </span>

        {(ahead > 0 || behind > 0) && (
          <span className="inline-flex items-center gap-3 font-mono font-bold shrink-0">
            {ahead > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-indigo-600"
                title={`${ahead} ahead of upstream`}
              >
                <CloudUpload className="size-4" />
                {ahead}
              </span>
            )}
            {behind > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-gray-500"
                title={`${behind} behind upstream`}
              >
                <CloudDownload className="size-4" />
                {behind}
              </span>
            )}
          </span>
        )}

        {dirtyBadges.length > 0 ? (
          <span className="inline-flex items-center gap-3 font-mono font-bold shrink-0">
            {dirtyBadges.map((b) => (
              <span
                key={b.key}
                className={`inline-flex items-center gap-0.5 ${b.color}`}
                title={`${b.count} ${b.label}`}
              >
                <b.Icon className="size-4" />
                {b.count}
              </span>
            ))}
          </span>
        ) : (
          <Check className="size-4 text-emerald-600 shrink-0" aria-label="clean working tree" />
        )}
      </div>

      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 min-w-0 sm:ml-auto hover:underline ${prStateColor}`}
          title={`#${pr.number} — ${pr.title} (${pr.isDraft ? "draft" : pr.state.toLowerCase()})`}
        >
          <GithubIcon className="size-4 shrink-0" />
          <span className="font-mono shrink-0">#{pr.number}</span>
          <span className="truncate sm:max-w-[28ch]">{pr.title}</span>
        </a>
      )}
    </div>
  );
}
