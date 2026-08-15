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
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Check,
  Terminal,
  Ticket,
  GitPullRequest,
  Settings as SettingsIcon,
  SquarePlus,
  Trash2,
  User,
  Zap,
} from "lucide-react";
import type {
  WorkspaceInfo,
  SessionInfo,
  SessionRefInfo,
  SessionSearchHit,
  SessionSearchResult,
  SessionRuntimeStatus,
  SessionDisposition,
} from "../hooks/useChatGateway";

// ── Props ───────────────────────────────────────────────────────

export type WorkspaceMenuAction =
  | "pin"
  | "refresh"
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
  onSessionSelect: (session: SessionInfo, workspace: WorkspaceInfo) => void;
  /**
   * Rename a session, or clear the rename with `null`. Optional: without it
   * the pencil affordance simply doesn't render.
   */
  onRenameSession?: (session: SessionInfo, title: string | null) => Promise<void> | void;
  /**
   * Set where a session's work stands. Optional: without it the row's status
   * menu doesn't render, which is what the VS Code sidebar mounts.
   */
  onSetSessionDisposition?: (
    session: SessionInfo,
    disposition: SessionDisposition,
  ) => Promise<void> | void;
  /** Create a session in the given workspace (defaults to active when omitted). */
  onNewSession: (workspace?: WorkspaceInfo) => void;
  onNewWorkspace: () => void;
  /** Fetch the next page of sessions for a workspace and append. */
  onLoadMoreSessions?: (workspaceId: string) => Promise<void> | void;
  /** ··· menu on a workspace row. Stub-friendly: caller can no-op. */
  onWorkspaceMenuAction?: (action: WorkspaceMenuAction, workspace: WorkspaceInfo) => void;
  /** Settings popup at the bottom. Stub-friendly. */
  onSettingsMenuAction?: (action: SettingsMenuAction) => void;
  /**
   * Full-text search across every message in every workspace.
   *
   * Optional: without it the search box stays the local title filter it always
   * was, which is what the VS Code sidebar mounts.
   */
  onSearchSessions?: (query: string) => Promise<SessionSearchResult>;
  /**
   * Sessions for the ACTIVE pane above the tree — in flight, or finished and
   * unacknowledged. Optional, like everything else here, so the VS Code
   * sidebar can mount the drawer without the gateway plumbing behind it.
   */
  activeSessions?: ActiveSessionRow[];
  /** Ticking clock for the pane's elapsed labels. */
  activeNow?: number;
  /** Mark a pane row done — it drops out of the pane and back into its tree. */
  onAcknowledgeSession?: (sessionId: string) => void;
}

/**
 * One row in the ACTIVE pane.
 *
 * Carries its workspace as a *label* rather than sitting under a workspace
 * parent: when something is happening, the workspace is context, not
 * hierarchy. That's the whole reason this pane exists — the tree is the wrong
 * shape for "what is going on right now", and collapsing a folder shouldn't
 * be able to hide live work.
 */
export interface ActiveSessionRow {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  title: string | null;
  firstPrompt: string | null;
  runtimeStatus: SessionRuntimeStatus;
  disposition: SessionDisposition;
  /** What the elapsed label counts from. */
  waitingSince: string;
  /** PR / ticket chips — a queue row should read like a tree row. */
  refs?: SessionRefInfo[];
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

/** Cap on chips per row, so one busy session can't swamp the list. */
const MAX_VISIBLE_REFS = 3;

/** The derived name — what a session is called before anyone renames it. */
function derivedSessionName(s: SessionInfo): string {
  if (s.firstPrompt) return s.firstPrompt;
  if (s.gitBranch) return s.gitBranch;
  return s.sessionId.slice(0, 8);
}

function formatSessionName(s: SessionInfo): string {
  return s.title?.trim() || derivedSessionName(s);
}

/** The command that attaches a terminal to a session's CLI pane. */
function tmuxAttachCommand(sessionId: string): string {
  return `tmux attach -t anima-cli-${sessionId}`;
}

// ── Status presentation ─────────────────────────────────────────

/**
 * How each runtime status reads in the nav.
 *
 * `idle` is absent, and `completed` is conditional. The original rule was that
 * both resting states show nothing — most rows are at rest, and a column of
 * grey dots costs the eye something on every scan while saying nothing.
 *
 * That was right in general and wrong for the one row that matters most.
 * A session that finished and hasn't been acknowledged is exactly the "I asked
 * for a PR review and forgot to come back" case, so it gets a mark; a session
 * that finished and *was* acknowledged goes quiet again. The principle held,
 * the boundary moved — see `runtimePresentation`.
 */
const RUNTIME_PRESENTATION: Partial<
  Record<SessionRuntimeStatus, { dotClass: string; label: string; pulse?: boolean }>
> = {
  // Motion, not a colour change: a spinner reads as "busy" at a glance in a
  // way a static dot doesn't, however brightly it pulses.
  running: { dotClass: "spinner", label: "Working" },
  awaiting_input: { dotClass: "bg-amber-500", label: "Waiting for you", pulse: true },
  awaiting_approval: { dotClass: "bg-amber-500", label: "Waiting for approval", pulse: true },
  failed: { dotClass: "bg-red-500", label: "Failed" },
  interrupted: { dotClass: "bg-gray-400", label: "Interrupted" },
  stalled: { dotClass: "bg-orange-500", label: "Stalled" },
};

/** Finished, and nobody has said they've dealt with it. */
const READY_PRESENTATION = { dotClass: "bg-blue-500", label: "Done — ready for you" };

function runtimePresentation(
  status?: SessionRuntimeStatus,
  disposition?: SessionDisposition,
): { dotClass: string; label: string; pulse?: boolean } | undefined {
  if (status === "completed") {
    return (disposition ?? "open") === "open" ? READY_PRESENTATION : undefined;
  }
  return status ? RUNTIME_PRESENTATION[status] : undefined;
}

// ── ACTIVE pane ─────────────────────────────────────────────────

/**
 * How many rows the pane shows before collapsing the rest behind a count.
 *
 * A busy morning must not push the workspace tree off-screen — the pane is
 * meant to answer "what's happening", not to become the whole sidebar.
 */
const MAX_ACTIVE_ROWS = 6;

function activeRowName(row: ActiveSessionRow): string {
  return row.title?.trim() || row.firstPrompt?.trim() || row.sessionId.slice(0, 8);
}

function elapsedLabel(since: string, now: number): string {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The flat "what's happening right now" list, above the workspace tree.
 *
 * Sorted by recency, except the session this tab is looking at, which is
 * pinned to the top — the row you're working in shouldn't move out from under
 * you because something finished elsewhere.
 */
function ActivePane({
  rows,
  activeSessionId,
  now,
  onSelect,
  onAcknowledge,
  onRenameSession,
  onSetDisposition,
}: {
  rows: ActiveSessionRow[];
  activeSessionId: string | null;
  now: number;
  onSelect: (row: ActiveSessionRow) => void;
  onAcknowledge?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string | null) => void;
  onSetDisposition?: (sessionId: string, disposition: SessionDisposition) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0) return null;

  const visible = showAll ? rows : rows.slice(0, MAX_ACTIVE_ROWS);
  const hidden = rows.length - visible.length;

  return (
    <div className="border-b border-gray-200 px-2 pb-2 pt-2">
      <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
        Active
      </div>
      <div className="space-y-0.5">
        {visible.map((row) => (
          <ActiveRow
            key={row.sessionId}
            row={row}
            isActive={row.sessionId === activeSessionId}
            now={now}
            onSelect={onSelect}
            onAcknowledge={onAcknowledge}
            onRenameSession={onRenameSession}
            onSetDisposition={onSetDisposition}
          />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full px-2 py-1 text-left text-xs text-gray-500 hover:text-gray-700"
          >
            {hidden} more
          </button>
        )}
        {showAll && rows.length > MAX_ACTIVE_ROWS && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="w-full px-2 py-1 text-left text-xs text-gray-500 hover:text-gray-700"
          >
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One queue row.
 *
 * Carries everything the tree row does — refs, rename, tmux, status — because
 * once the queue is where the work lives, having to go find the session in its
 * folder to rename it is exactly the friction the pane was meant to remove.
 */
function ActiveRow({
  row,
  isActive,
  now,
  onSelect,
  onAcknowledge,
  onRenameSession,
  onSetDisposition,
}: {
  row: ActiveSessionRow;
  isActive: boolean;
  now: number;
  onSelect: (row: ActiveSessionRow) => void;
  onAcknowledge?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string | null) => void;
  onSetDisposition?: (sessionId: string, disposition: SessionDisposition) => void;
}) {
  const [renaming, setRenaming] = useState(false);

  if (renaming && onRenameSession) {
    return (
      <div className="flex w-full items-center px-2 py-1.5">
        <SessionTitleInput
          initial={row.title ?? ""}
          placeholder={activeRowName(row)}
          onCancel={() => setRenaming(false)}
          onCommit={(value) => {
            setRenaming(false);
            onRenameSession(row.sessionId, value);
          }}
        />
      </div>
    );
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(row)}
        className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 pr-16 text-left text-sm transition-colors ${
          isActive
            ? "bg-gray-100 text-gray-900"
            : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
        }`}
      >
        <RuntimeStatusDot status={row.runtimeStatus} disposition={row.disposition} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{activeRowName(row)}</span>
          <span className="block truncate text-xs text-gray-400">
            {row.workspaceName} · {elapsedLabel(row.waitingSince, now)}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 empty:mt-0">
            {/* The session you have open stays in the queue whatever its
                status, so the chip is the only thing that shows a resolve
                actually landed. Without it, marking the current session done
                looks like nothing happened. */}
            <DispositionChip disposition={row.disposition} />
            <SessionRefChips refs={row.refs} />
          </span>
        </span>
      </button>
      <span className="absolute right-2 top-1.5 hidden items-center gap-0.5 group-hover:flex">
        {/* Any row can be marked done, not just finished ones. This is a work
            queue — "I'm done with this" is a statement about you, not about
            what the agent happens to be doing this second. */}
        {onAcknowledge && row.disposition !== "resolved" && (
          <RowAction icon={Check} label="Mark done" onClick={() => onAcknowledge(row.sessionId)} />
        )}
        <SessionActions
          sessionId={row.sessionId}
          disposition={row.disposition}
          onRename={onRenameSession ? () => setRenaming(true) : undefined}
          onSetDisposition={
            onSetDisposition
              ? (disposition) => onSetDisposition(row.sessionId, disposition)
              : undefined
          }
        />
      </span>
    </div>
  );
}

/**
 * How each disposition reads. `open` has no chip — it's the default, and
 * labelling every untouched session "Open" would be noise.
 */
const DISPOSITION_PRESENTATION: Partial<
  Record<SessionDisposition, { label: string; className: string }>
> = {
  needs_review: { label: "Needs review", className: "bg-blue-50 text-blue-700 ring-blue-200" },
  blocked: { label: "Blocked", className: "bg-red-50 text-red-700 ring-red-200" },
  snoozed: { label: "Snoozed", className: "bg-gray-100 text-gray-600 ring-gray-200" },
  resolved: { label: "Resolved", className: "bg-green-50 text-green-700 ring-green-200" },
  archived: { label: "Archived", className: "bg-gray-100 text-gray-500 ring-gray-200" },
};

/** The order dispositions appear in the row menu. */
const DISPOSITION_MENU: SessionDisposition[] = [
  "open",
  "needs_review",
  "blocked",
  "snoozed",
  "resolved",
  "archived",
];

const DISPOSITION_MENU_LABELS: Record<SessionDisposition, string> = {
  open: "Open",
  needs_review: "Needs review",
  blocked: "Blocked",
  snoozed: "Snoozed",
  resolved: "Resolved",
  archived: "Archived",
};

function RuntimeStatusDot({
  status,
  disposition,
}: {
  status?: SessionRuntimeStatus;
  disposition?: SessionDisposition;
}) {
  const presentation = runtimePresentation(status, disposition);
  if (!presentation) return null;

  if (presentation.dotClass === "spinner") {
    return (
      <span
        title={presentation.label}
        aria-label={presentation.label}
        role="img"
        className="mt-1 inline-block size-2.5 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-emerald-500 border-t-transparent"
      />
    );
  }

  return (
    <span
      title={presentation.label}
      aria-label={presentation.label}
      role="img"
      className={`mt-1.5 inline-block size-2 flex-shrink-0 rounded-full ${presentation.dotClass} ${
        presentation.pulse ? "animate-pulse" : ""
      }`}
    />
  );
}

function DispositionChip({ disposition }: { disposition?: SessionDisposition }) {
  const presentation = disposition ? DISPOSITION_PRESENTATION[disposition] : undefined;
  if (!presentation) return null;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${presentation.className}`}
    >
      {presentation.label}
    </span>
  );
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
      <Icon className="size-4 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ── Session row ─────────────────────────────────────────────────

function SessionRow({
  session,
  isActive,
  href,
  onSelect,
  onRename,
  onSetDisposition,
}: {
  session: SessionInfo;
  isActive: boolean;
  href: string;
  onSelect: () => void;
  /** Omitted when the host hasn't wired renaming — the affordance hides. */
  onRename?: (session: SessionInfo, title: string | null) => Promise<void> | void;
  /** Omitted when the host hasn't wired the human status axis. */
  onSetDisposition?: (
    session: SessionInfo,
    disposition: SessionDisposition,
  ) => Promise<void> | void;
}) {
  const [renaming, setRenaming] = useState(false);

  // Real <a> so right-click / cmd-click / middle-click open in a new tab.
  // Plain left-click is intercepted and routed through the SPA navigator.
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onSelect();
  };

  if (renaming && onRename) {
    return (
      <div className="flex w-full items-center py-1.5 pl-9 pr-3">
        <SessionTitleInput
          initial={session.title ?? ""}
          placeholder={derivedSessionName(session)}
          onCancel={() => setRenaming(false)}
          onCommit={async (value) => {
            setRenaming(false);
            await onRename(session, value);
          }}
        />
      </div>
    );
  }

  return (
    // The actions are siblings of the anchor, not children of it: a <button>
    // inside an <a> is invalid HTML, and it also poisons the row's accessible
    // name — a screen reader announced the session as "Copy tmux attach
    // command". Overlaying them keeps the whole row clickable underneath.
    <div className="group relative">
      <a
        href={href}
        onClick={handleClick}
        // Full-width highlight (no rounded corners, no left margin) — the
        // text gets the indent via pl-9 instead, so the active session reads
        // as a flat row across the entire sidebar.
        className={`flex w-full items-start justify-between gap-2 py-1.5 pl-9 pr-3 text-left text-sm transition-colors ${
          isActive
            ? "bg-gray-100 text-gray-900"
            : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
        }`}
      >
        <span className="flex min-w-0 flex-1 items-start gap-1.5">
          <RuntimeStatusDot status={session.runtimeStatus} disposition={session.disposition} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{formatSessionName(session)}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1 empty:mt-0">
              <DispositionChip disposition={session.disposition} />
              <SessionRefChips refs={session.refs} />
            </span>
          </span>
        </span>
        {/* Hidden on hover so the actions can take its place — the row is
            dense already, and the time is the less useful of the two once
            you've reached for the mouse. */}
        <span className="flex-shrink-0 pt-0.5 text-xs text-gray-400 group-hover:invisible">
          {formatTimeAgo(session.modified || session.created || "")}
        </span>
      </a>
      <span className="absolute right-2 top-1.5 hidden items-center gap-0.5 group-hover:flex">
        <SessionActions
          sessionId={session.sessionId}
          disposition={session.disposition}
          onRename={onRename ? () => setRenaming(true) : undefined}
          onSetDisposition={
            onSetDisposition
              ? (disposition) => void onSetDisposition(session, disposition)
              : undefined
          }
        />
      </span>
    </div>
  );
}

/**
 * The per-session action cluster: copy tmux command, rename, set status.
 *
 * Shared by the tree row and the ACTIVE queue row rather than written twice.
 * They're the same session seen from two angles, and an action available in
 * one place but not the other is the kind of inconsistency you only notice
 * while hunting for the button that was there a second ago.
 *
 * Everything but the tmux copy lives behind the ⋯ menu, because the queue row
 * carries a workspace label and refs and has no width to spare.
 */
function SessionActions({
  sessionId,
  disposition,
  onRename,
  onSetDisposition,
}: {
  sessionId: string;
  disposition?: SessionDisposition;
  onRename?: () => void;
  onSetDisposition?: (disposition: SessionDisposition) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useClickOutside<HTMLSpanElement>(menuOpen, () => setMenuOpen(false));

  const handleCopyAttach = async () => {
    await copyText(tmuxAttachCommand(sessionId));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const hasMenu = Boolean(onRename || onSetDisposition);

  return (
    <>
      <RowAction
        icon={copied ? Check : Terminal}
        label={copied ? "Copied" : "Copy tmux attach command"}
        onClick={handleCopyAttach}
      />
      {hasMenu && (
        <span className="relative" ref={menuRef}>
          <RowAction
            icon={MoreHorizontal}
            label="Session actions"
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen && (
            <span className="absolute right-0 top-6 z-30 flex w-44 flex-col rounded-md border border-gray-200 bg-white py-1 shadow-lg">
              {onRename && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onRename();
                    }}
                    className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50"
                  >
                    <Pencil className="size-3" />
                    Rename
                  </button>
                  <span className="my-1 border-t border-gray-100" />
                </>
              )}
              {onSetDisposition && (
                <>
                  <span className="px-3 pb-1 text-[10px] uppercase tracking-wide text-gray-400">
                    Status
                  </span>
                  {DISPOSITION_MENU.map((option) => {
                    const current = (disposition ?? "open") === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          if (!current) onSetDisposition(option);
                        }}
                        className={`flex items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-gray-50 ${
                          current ? "font-medium text-gray-900" : "text-gray-600"
                        }`}
                      >
                        {DISPOSITION_MENU_LABELS[option]}
                        {current && <Check className="size-3" />}
                      </button>
                    );
                  })}
                </>
              )}
            </span>
          )}
        </span>
      )}
    </>
  );
}

/** Small icon button living inside the session row's anchor. */
function RowAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/**
 * Clipboard write with a fallback.
 *
 * `navigator.clipboard` is unavailable outside a secure context, and Anima is
 * reached over plain HTTP on the Tailscale address — so the modern API alone
 * would silently do nothing on exactly the devices this button is for.
 */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(field);
  }
}

/**
 * Inline rename field.
 *
 * Enter commits, Escape cancels, blur commits — an accidental click elsewhere
 * shouldn't throw away typing. Submitting an empty value clears the rename,
 * which is why the placeholder shows the derived title: it's a preview of
 * exactly what you get back.
 */
function SessionTitleInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (title: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const committed = useRef(false);

  const commit = (): void => {
    if (committed.current) return;
    committed.current = true;
    const trimmed = value.trim();
    if (trimmed === initial.trim()) {
      onCancel();
      return;
    }
    onCommit(trimmed ? trimmed : null);
  };

  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
      className="w-full rounded border border-gray-300 bg-white px-1.5 py-0.5 text-sm text-gray-900 outline-none focus:border-gray-500"
    />
  );
}

// ── Ref chips ───────────────────────────────────────────────────

/**
 * PR / ticket chips under a session title.
 *
 * The point is glanceability — being able to scan the list for "the #28388
 * work" without opening anything. Chips are capped so a session that mentions
 * a dozen tickets can't push the row into a wall of badges.
 */
function SessionRefChips({ refs }: { refs?: SessionRefInfo[] }) {
  if (!refs?.length) return null;

  const shown = refs.slice(0, MAX_VISIBLE_REFS);
  const overflow = refs.length - shown.length;

  // No vertical margin of its own — callers place it, because it now shares a
  // row with the disposition chip and the two must sit on the same baseline.
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((ref) => {
        const isLinear = ref.type === "linear";
        const chip = (
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${
              isLinear ? "bg-indigo-50 text-indigo-700" : "bg-gray-100 text-gray-600"
            }`}
          >
            {isLinear ? (
              <Ticket className="h-2.5 w-2.5" aria-hidden />
            ) : (
              <GitPullRequest className="h-2.5 w-2.5" aria-hidden />
            )}
            {ref.label}
          </span>
        );

        // Chips live inside the session <a>, so a nested anchor is invalid.
        // Stop propagation instead and navigate manually, keeping the row
        // click (open session) and the chip click (open PR/ticket) distinct.
        return ref.url ? (
          <span
            key={ref.key}
            role="link"
            tabIndex={0}
            title={ref.url}
            className="cursor-pointer hover:opacity-80"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(ref.url, "_blank", "noopener,noreferrer");
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              window.open(ref.url, "_blank", "noopener,noreferrer");
            }}
          >
            {chip}
          </span>
        ) : (
          <span key={ref.key}>{chip}</span>
        );
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-gray-400" title={refs.map((r) => r.label).join(", ")}>
          +{overflow}
        </span>
      )}
    </span>
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
  onRenameSession,
  onSetSessionDisposition,
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
  onSessionSelect: (session: SessionInfo, workspace: WorkspaceInfo) => void;
  onRenameSession?: (session: SessionInfo, title: string | null) => Promise<void> | void;
  onSetSessionDisposition?: (
    session: SessionInfo,
    disposition: SessionDisposition,
  ) => Promise<void> | void;
  onNewSession: (workspace: WorkspaceInfo) => void;
  onLoadMore?: (workspaceId: string) => Promise<void> | void;
  onMenuAction?: (action: WorkspaceMenuAction, workspace: WorkspaceInfo) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loadingMore, setLoadingMore] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useClickOutside<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  // No auto-expand. The ACTIVE queue above already surfaces live work from
  // every workspace, so opening a folder because its workspace became current
  // just unfolds the tree behind a list that already answered the question.
  // Folders stay exactly as the user left them.

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
      {/* Workspace header row — never highlighted; only the active session
          inside it gets the highlight (matches Codex). */}
      <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-gray-50">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="relative flex-shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
          {workspace.pinned && (
            // Pinned indicator — small blue dot on the upper-right corner
            // of the folder icon, like a notification badge.
            <span
              className="absolute right-0 top-0 size-1.5 rounded-full bg-blue-500"
              aria-label="Pinned"
            />
          )}
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
              <MoreHorizontal className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => onNewSession(workspace)}
              className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
              title="New session"
            >
              <SquarePlus className="size-4" />
            </button>
          </div>
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg"
            >
              <WorkspaceMenuItem
                icon={workspace.pinned ? PinOff : Pin}
                label={workspace.pinned ? "Unpin workspace" : "Pin workspace"}
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("pin", workspace);
                }}
              />
              <WorkspaceMenuItem
                icon={RefreshCw}
                label="Refresh sessions"
                onClick={() => {
                  setMenuOpen(false);
                  onMenuAction?.("refresh", workspace);
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
                label="Rename workspace"
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

      {/* Sessions list — full-width rows; the indent lives on each row's
          left padding so the active highlight runs edge-to-edge. */}
      {expanded && (
        <div className="mt-0.5 space-y-0.5">
          {sessions.length === 0 ? (
            <div className="py-1 pl-9 pr-3 text-xs text-gray-400">No sessions yet</div>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                isActive={isActive && activeSessionId === session.sessionId}
                href={`/chat/${workspace.id}/${session.sessionId}`}
                onSelect={() => onSessionSelect(session, workspace)}
                onRename={onRenameSession}
                onSetDisposition={onSetSessionDisposition}
              />
            ))
          )}
          {hasMore && (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="py-1 pl-9 pr-3 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
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
      <Icon className="size-4 flex-shrink-0" />
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
          <User className="size-4 text-gray-500" />
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

/** How long typing has to settle before a query goes to the server. */
const SEARCH_DEBOUNCE_MS = 180;

/**
 * Render a snippet, bolding the matched terms.
 *
 * The server wraps matches in `«»` — chosen because they never occur in code
 * or prose here, so splitting on them can't misfire the way `**` or `<b>`
 * would in a transcript full of markdown and HTML.
 */
function SnippetText({ snippet }: { snippet: string }) {
  const parts = snippet.split(/«([^»]*)»/g);
  return (
    <span className="text-xs leading-relaxed text-gray-500">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          // eslint-disable-next-line react/no-array-index-key -- split order is the identity
          <mark key={i} className="rounded-sm bg-amber-100 px-0.5 text-gray-900">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/**
 * Find a session by what was said in it.
 *
 * With an empty box this is still the recent-chats list it always was — the
 * fast path for "the thing I had open ten minutes ago". Type, and it becomes a
 * full-text search over every message in every workspace, which is a different
 * question ("where did we work out the port hashing?") and needs the server.
 */
function SearchModal({
  workspaces,
  sessionsByWorkspace,
  onSearch,
  onClose,
  onSelect,
}: {
  workspaces: WorkspaceInfo[];
  sessionsByWorkspace: Record<string, SessionInfo[]>;
  onSearch?: (query: string) => Promise<SessionSearchResult>;
  onClose: () => void;
  onSelect: (workspace: WorkspaceInfo, session: SessionInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SessionSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when the modal opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search. The generation counter is what keeps a slow early query
  // from overwriting the results of a later, faster one.
  useEffect(() => {
    if (!onSearch || !query.trim()) {
      setResult(null);
      setSearching(false);
      return;
    }

    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      onSearch(query)
        .then((next) => {
          if (!live) return;
          setResult(next);
          setCursor(0);
        })
        .catch((error: unknown) => {
          if (!live) return;
          console.error("Search failed", error);
          setResult({ hits: [], relaxed: false });
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, onSearch]);

  // Recent chats — the empty-query view, and the fallback when no search
  // handler is wired (the VS Code sidebar mounts the drawer without one).
  const recent = useMemo(() => {
    const rows: Array<{ workspace: WorkspaceInfo; session: SessionInfo }> = [];
    for (const ws of workspaces) {
      for (const session of sessionsByWorkspace[ws.id] ?? []) rows.push({ workspace: ws, session });
    }
    rows.sort((a, b) => {
      const at = a.session.modified || a.session.created || "";
      const bt = b.session.modified || b.session.created || "";
      return bt.localeCompare(at);
    });
    if (!query) return rows.slice(0, 50);
    const q = query.toLowerCase();
    return rows.filter(
      ({ workspace, session }) =>
        formatSessionName(session).toLowerCase().includes(q) ||
        workspace.name.toLowerCase().includes(q),
    );
  }, [workspaces, sessionsByWorkspace, query]);

  const searchMode = Boolean(onSearch && query.trim());

  const openHit = (hit: SessionSearchHit) => {
    const workspace = workspaces.find((ws) => ws.id === hit.workspaceId);
    if (!workspace) return;
    // A hit can name a session this workspace hasn't paged in, so the row is
    // synthesized from what search returned rather than looked up.
    onSelect(workspace, {
      sessionId: hit.sessionId,
      title: hit.title,
      modified: hit.matchedAt,
      refs: hit.refs,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    const hits = result?.hits;
    if (!searchMode || !hits?.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) openHit(hit);
    }
  };

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label="Close search"
      className="fixed inset-0 z-50 flex items-start justify-center bg-gradient-to-b from-black/10 to-black/20 pt-24 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat search"
        className="w-full max-w-xl overflow-hidden rounded-lg bg-white shadow-2xl"
      >
        <div className="border-b border-gray-200 p-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={onSearch ? "Search every message" : "Search chats"}
            className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
          />
        </div>
        <div className="max-h-96 overflow-y-auto py-1">
          <div className="flex items-center justify-between px-3 py-1 text-xs uppercase tracking-wide text-gray-400">
            <span>{query ? "Results" : "Recent chats"}</span>
            {searching && <span className="normal-case tracking-normal">searching…</span>}
          </div>

          {searchMode ? (
            <SearchResults result={result} searching={searching} cursor={cursor} onOpen={openHit} />
          ) : recent.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">No matches</div>
          ) : (
            recent.map(({ workspace, session }) => {
              const href = `/chat/${workspace.id}/${session.sessionId}`;
              return (
                <a
                  key={`${workspace.id}-${session.sessionId}`}
                  href={href}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    onSelect(workspace, session);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                >
                  <span className="truncate text-gray-700">{formatSessionName(session)}</span>
                  <span className="flex-shrink-0 text-xs text-gray-400">{workspace.name}</span>
                </a>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function SearchResults({
  result,
  searching,
  cursor,
  onOpen,
}: {
  result: SessionSearchResult | null;
  searching: boolean;
  cursor: number;
  onOpen: (hit: SessionSearchHit) => void;
}) {
  const hits = result?.hits ?? null;
  if (hits === null) {
    return (
      <div className="px-3 py-2 text-sm text-gray-400">{searching ? "" : "Type to search"}</div>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="px-3 py-3 text-sm text-gray-500">
        No matches.
        {/* Stated rather than hidden: a search that silently can't see tool
            output teaches you to distrust it. */}
        <div className="mt-1 text-xs text-gray-400">
          Prompts and replies are searchable; command output isn&apos;t indexed.
        </div>
      </div>
    );
  }

  return (
    <>
      {result?.relaxed && (
        <div className="px-3 pb-1 text-xs text-gray-400">
          No message contained every word — showing sessions matching any of them.
        </div>
      )}
      {hits.map((hit, i) => (
        <button
          key={hit.sessionId}
          type="button"
          onClick={() => onOpen(hit)}
          className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-gray-50 ${
            i === cursor ? "bg-gray-50" : ""
          }`}
        >
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm text-gray-700">{hit.title}</span>
            <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-gray-400">
              {hit.matches > 1 && <span>{hit.matches}×</span>}
              <span>{hit.workspaceName}</span>
            </span>
          </span>
          <SnippetText snippet={hit.snippet} />
          <span className="mt-0.5 flex items-center gap-2">
            <SessionRefChips refs={hit.refs} />
            {hit.archived && (
              <span
                className="text-[10px] text-gray-400"
                title="Transcript was deleted by Claude Code; only the indexed conversation remains"
              >
                archived
              </span>
            )}
          </span>
        </button>
      ))}
    </>
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
  onRenameSession,
  onSetSessionDisposition,
  onNewSession,
  onNewWorkspace,
  onLoadMoreSessions,
  onWorkspaceMenuAction,
  onSettingsMenuAction,
  onSearchSessions,
  activeSessions,
  activeNow,
  onAcknowledgeSession,
}: NavigationDrawerProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The session this tab is looking at sorts first, whatever its recency —
  // the row you are working in shouldn't slide away because something
  // finished in another workspace. Everything else stays newest-first, which
  // is the order the server already returned.
  const activeRows = useMemo(() => {
    if (!activeSessions?.length) return [];
    const pinned = activeSessions.filter((row) => row.sessionId === activeSessionId);
    const rest = activeSessions.filter((row) => row.sessionId !== activeSessionId);
    return [...pinned, ...rest];
  }, [activeSessions, activeSessionId]);

  return (
    <>
      <div className="flex h-full w-full flex-col border-r border-gray-200 bg-white">
        {/* Fixed top */}
        <div className="flex flex-col gap-0.5 border-b border-gray-200 p-2">
          <TopAction icon={Plus} label="New workspace" onClick={onNewWorkspace} />
          <TopAction icon={Search} label="Search" onClick={() => setSearchOpen(true)} />
        </div>

        <ActivePane
          rows={activeRows}
          activeSessionId={activeSessionId}
          now={activeNow ?? Date.now()}
          onSelect={(row) => {
            const workspace = workspaces.find((w) => w.id === row.workspaceId);
            if (workspace) {
              onSessionSelect({ sessionId: row.sessionId }, workspace);
            }
          }}
          onAcknowledge={onAcknowledgeSession}
          onRenameSession={
            onRenameSession
              ? (sessionId, title) => void onRenameSession({ sessionId }, title)
              : undefined
          }
          onSetDisposition={
            onSetSessionDisposition
              ? (sessionId, disposition) => void onSetSessionDisposition({ sessionId }, disposition)
              : undefined
          }
        />

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
                defaultExpanded={false}
                onWorkspaceSelect={onWorkspaceSelect}
                onSessionSelect={onSessionSelect}
                onRenameSession={onRenameSession}
                onSetSessionDisposition={onSetSessionDisposition}
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
          onSearch={onSearchSessions}
          onClose={() => setSearchOpen(false)}
          onSelect={(workspace, session) => {
            setSearchOpen(false);
            // Single navigate — onSessionSelect carries the workspace, so
            // we don't race a `latest` redirect from onWorkspaceSelect.
            onSessionSelect(session, workspace);
          }}
        />
      )}
    </>
  );
}
