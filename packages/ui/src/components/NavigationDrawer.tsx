/**
 * NavigationDrawer — Codex-style sidebar.
 *
 * Layout (top to bottom):
 *   FIXED TOP    — New workspace, Search, Plugins, Automations
 *   SCROLL MID   — "Workspaces" header + collapsible workspace items, each
 *                  showing up to 5 sessions with a "Show more" toggle.
 *   FIXED BOTTOM — Settings (popup menu)
 *
 * Per-workspace state (expanded, show-more) lives in this component because
 * it's purely UI; persistent state (active workspace/session) flows down
 * via props.
 *
 * Most of the menu actions and the Search modal are no-op stubs for now —
 * the visual scaffold is in place so we can wire backend calls one at a
 * time without touching the layout again.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Folder,
  FolderOpen,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  SquarePlus,
  Trash2,
  User,
  Zap,
} from "lucide-react";
import type { WorkspaceInfo, SessionInfo } from "../hooks/useChatGateway";

// ── Props ───────────────────────────────────────────────────────

export type WorkspaceMenuAction =
  | "pin"
  | "openInFinder"
  | "createWorktree"
  | "rename"
  | "archive"
  | "remove";

export type SettingsMenuAction = "settings" | "rateLimits" | "logout";

interface NavigationDrawerProps {
  workspaces: WorkspaceInfo[];
  /** Sessions per workspace, keyed by `workspace.id`. Server-paginated. */
  sessionsByWorkspace: Record<string, SessionInfo[]>;
  /**
   * Whether each workspace still has more sessions on the server, keyed by
   * `workspace.id`. Drives the "Show more" affordance — hidden when false.
   */
  hasMoreByWorkspace?: Record<string, boolean>;
  activeWorkspace: WorkspaceInfo | null;
  activeSessionId: string | null;
  isConnected: boolean;
  onWorkspaceSelect: (workspace: WorkspaceInfo) => void;
  onSessionSelect: (session: SessionInfo) => void;
  /** Create a session in the given workspace (defaults to active when omitted). */
  onNewSession: (workspace?: WorkspaceInfo) => void;
  onNewWorkspace: () => void;
  /** Fetch the next page of sessions for a workspace and append. */
  onLoadMoreSessions?: (workspaceId: string) => Promise<void> | void;
  /** ··· menu on a workspace row. Stub-friendly: caller can no-op. */
  onWorkspaceMenuAction?: (action: WorkspaceMenuAction, workspace: WorkspaceInfo) => void;
  /** Settings popup at the bottom. Stub-friendly. */
  onSettingsMenuAction?: (action: SettingsMenuAction) => void;
}

// ── Time formatting ─────────────────────────────────────────────

function formatTimeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffWeeks < 5) return `${diffWeeks}w`;
  return `${diffMonths}mo`;
}

function formatSessionName(s: SessionInfo): string {
  if (s.firstPrompt) return s.firstPrompt;
  if (s.gitBranch) return s.gitBranch;
  return s.sessionId.slice(0, 8);
}

// ── Click-outside hook ──────────────────────────────────────────

function useClickOutside<T extends HTMLElement>(
  enabled: boolean,
  onOutside: () => void,
): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [enabled, onOutside]);
  return ref;
}

// ── Top action button ───────────────────────────────────────────

function TopAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Plus;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
        disabled
          ? "cursor-not-allowed text-gray-400"
          : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
      }`}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ── Session row ─────────────────────────────────────────────────

function SessionRow({
  session,
  isActive,
  onClick,
}: {
  session: SessionInfo;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
        isActive
          ? "bg-gray-100 text-gray-900"
          : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
      }`}
    >
      <span className="truncate">{formatSessionName(session)}</span>
      <span className="flex-shrink-0 text-xs text-gray-400">
        {formatTimeAgo(session.modified || session.created || "")}
      </span>
    </button>
  );
}

// ── Workspace item ──────────────────────────────────────────────

function WorkspaceItem({
  workspace,
  sessions,
  hasMore,
  isActive,
  activeSessionId,
  defaultExpanded,
  onWorkspaceSelect,
  onSessionSelect,
  onNewSession,
  onLoadMore,
  onMenuAction,
}: {
  workspace: WorkspaceInfo;
  sessions: SessionInfo[];
  /** True when the server has more sessions beyond what we've fetched. */
  hasMore: boolean;
  isActive: boolean;
  activeSessionId: string | null;
  defaultExpanded: boolean;
  onWorkspaceSelect: (workspace: WorkspaceInfo) => void;
  onSessionSelect: (session: SessionInfo) => void;
  onNewSession: (workspace: WorkspaceInfo) => void;
  onLoadMore?: (workspaceId: string) => Promise<void> | void;
  onMenuAction?: (action: WorkspaceMenuAction, workspace: WorkspaceInfo) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loadingMore, setLoadingMore] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useClickOutside<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  // Auto-expand when this workspace becomes active.
  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  const handleLoadMore = async () => {
    if (!onLoadMore || loadingMore) return;
    setLoadingMore(true);
    try {
      await onLoadMore(workspace.id);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div>
      {/* Workspace header row */}
      <div
        className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
          isActive ? "bg-gray-100" : "hover:bg-gray-50"
        }`}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => onWorkspaceSelect(workspace)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <span className="w-full truncate text-sm font-medium text-gray-900">
            {workspace.name}
          </span>
        </button>

        {/* Hover actions: ··· menu and new session */}
        <div className="relative flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
              title="More actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onNewSession(workspace)}
              className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
              title="New session"
            >
              <SquarePlus className="h-4 w-4" />
            </button>
          </div>
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg"
            >
              <WorkspaceMenuItem
                icon={Pencil}
                label="Pin project"
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("pin", workspace);
                }}
              />
              <WorkspaceMenuItem
                icon={Folder}
                label="Open in Finder"
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("openInFinder", workspace);
                }}
              />
              <WorkspaceMenuItem
                icon={Puzzle}
                label="Create permanent worktree"
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("createWorktree", workspace);
                }}
              />
              <WorkspaceMenuItem
                icon={Pencil}
                label="Rename project"
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("rename", workspace);
                }}
              />
              <div className="my-1 border-t border-gray-200" />
              <WorkspaceMenuItem
                icon={Trash2}
                label="Archive chats"
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("archive", workspace);
                }}
              />
              <WorkspaceMenuItem
                icon={Trash2}
                label="Remove"
                destructive
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("remove", workspace);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Sessions list — indented under the workspace */}
      {expanded && (
        <div className="ml-6 mt-0.5 space-y-0.5">
          {sessions.length === 0 ? (
            <div className="px-3 py-1 text-xs text-gray-400">No sessions yet</div>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                isActive={isActive && activeSessionId === session.sessionId}
                onClick={() => onSessionSelect(session)}
              />
            ))
          )}
          {hasMore && (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceMenuItem({
  icon: Icon,
  label,
  onClick,
  destructive,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
        destructive ? "text-red-600 hover:bg-red-50" : "text-gray-700 hover:bg-gray-100"
      }`}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      <span>{label}</span>
    </button>
  );
}

// ── Settings popup ──────────────────────────────────────────────

function SettingsPopup({
  onAction,
  onClose,
}: {
  onAction?: (action: SettingsMenuAction) => void;
  onClose: () => void;
}) {
  const ref = useClickOutside<HTMLDivElement>(true, onClose);
  return (
    <div
      ref={ref}
      className="absolute bottom-full left-2 mb-1 w-60 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg"
    >
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-gray-700">
          <User className="h-4 w-4 text-gray-500" />
          <span className="truncate">kiliman@gmail.com</span>
        </div>
        <div className="mt-1 ml-6 text-xs text-gray-500">Personal account</div>
      </div>
      <WorkspaceMenuItem
        icon={SettingsIcon}
        label="Settings"
        onClick={() => {
          onClose();
          onAction?.("settings");
        }}
      />
      <WorkspaceMenuItem
        icon={Zap}
        label="Rate limits remaining"
        onClick={() => {
          onClose();
          onAction?.("rateLimits");
        }}
      />
      <div className="my-1 border-t border-gray-200" />
      <WorkspaceMenuItem
        icon={LogOut}
        label="Log out"
        onClick={() => {
          onClose();
          onAction?.("logout");
        }}
      />
    </div>
  );
}

// ── Search modal ────────────────────────────────────────────────

function SearchModal({
  workspaces,
  sessionsByWorkspace,
  onClose,
  onSelect,
}: {
  workspaces: WorkspaceInfo[];
  sessionsByWorkspace: Record<string, SessionInfo[]>;
  onClose: () => void;
  onSelect: (workspace: WorkspaceInfo, session: SessionInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when the modal opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Flatten sessions across workspaces, sorted by modified desc, with their
  // workspace name attached for the right-side label.
  const flatSessions = useMemo(() => {
    const rows: Array<{ workspace: WorkspaceInfo; session: SessionInfo }> = [];
    for (const ws of workspaces) {
      for (const session of sessionsByWorkspace[ws.id] ?? []) {
        rows.push({ workspace: ws, session });
      }
    }
    rows.sort((a, b) => {
      const at = a.session.modified || a.session.created || "";
      const bt = b.session.modified || b.session.created || "";
      return bt.localeCompare(at);
    });
    if (!query) return rows.slice(0, 50);
    const q = query.toLowerCase();
    return rows.filter(({ workspace, session }) => {
      return (
        formatSessionName(session).toLowerCase().includes(q) ||
        workspace.name.toLowerCase().includes(q)
      );
    });
  }, [workspaces, sessionsByWorkspace, query]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 p-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
          />
        </div>
        <div className="max-h-96 overflow-y-auto py-1">
          <div className="px-3 py-1 text-xs uppercase tracking-wide text-gray-400">
            {query ? "Results" : "Recent chats"}
          </div>
          {flatSessions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">No matches</div>
          ) : (
            flatSessions.map(({ workspace, session }) => (
              <button
                key={`${workspace.id}-${session.sessionId}`}
                type="button"
                onClick={() => onSelect(workspace, session)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="truncate text-gray-700">{formatSessionName(session)}</span>
                <span className="flex-shrink-0 text-xs text-gray-400">{workspace.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────

export function NavigationDrawer({
  workspaces,
  sessionsByWorkspace,
  hasMoreByWorkspace,
  activeWorkspace,
  activeSessionId,
  onWorkspaceSelect,
  onSessionSelect,
  onNewSession,
  onNewWorkspace,
  onLoadMoreSessions,
  onWorkspaceMenuAction,
  onSettingsMenuAction,
}: NavigationDrawerProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <div className="flex h-full w-full flex-col border-r border-gray-200 bg-white">
        {/* Fixed top */}
        <div className="flex flex-col gap-0.5 border-b border-gray-200 p-2">
          <TopAction icon={Plus} label="New workspace" onClick={onNewWorkspace} />
          <TopAction icon={Search} label="Search" onClick={() => setSearchOpen(true)} />
          <TopAction icon={Puzzle} label="Plugins" disabled />
          <TopAction icon={Zap} label="Automations" disabled />
        </div>

        {/* Scrollable workspaces */}
        <div className="flex-1 overflow-y-auto p-2">
          <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
            Workspaces
          </div>
          <div className="space-y-0.5">
            {workspaces.map((workspace) => (
              <WorkspaceItem
                key={workspace.id}
                workspace={workspace}
                sessions={sessionsByWorkspace[workspace.id] ?? []}
                hasMore={hasMoreByWorkspace?.[workspace.id] ?? false}
                isActive={activeWorkspace?.id === workspace.id}
                activeSessionId={activeSessionId}
                defaultExpanded={activeWorkspace?.id === workspace.id}
                onWorkspaceSelect={onWorkspaceSelect}
                onSessionSelect={onSessionSelect}
                onNewSession={onNewSession}
                onLoadMore={onLoadMoreSessions}
                onMenuAction={onWorkspaceMenuAction}
              />
            ))}
          </div>
        </div>

        {/* Fixed bottom */}
        <div className="relative border-t border-gray-200 p-2">
          <TopAction
            icon={SettingsIcon}
            label="Settings"
            onClick={() => setSettingsOpen((v) => !v)}
          />
          {settingsOpen && (
            <SettingsPopup onAction={onSettingsMenuAction} onClose={() => setSettingsOpen(false)} />
          )}
        </div>
      </div>

      {searchOpen && (
        <SearchModal
          workspaces={workspaces}
          sessionsByWorkspace={sessionsByWorkspace}
          onClose={() => setSearchOpen(false)}
          onSelect={(workspace, session) => {
            setSearchOpen(false);
            onWorkspaceSelect(workspace);
            onSessionSelect(session);
          }}
        />
      )}
    </>
  );
}
