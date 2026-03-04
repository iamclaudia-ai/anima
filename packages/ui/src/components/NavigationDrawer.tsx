import { useEffect, useState } from "react";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import type { WorkspaceInfo, SessionInfo } from "../hooks/useChatGateway";

interface NavigationDrawerProps {
  workspaces: WorkspaceInfo[];
  sessions: SessionInfo[];
  activeWorkspace: WorkspaceInfo | null;
  activeSessionId: string | null;
  isConnected: boolean;
  onWorkspaceSelect: (workspace: WorkspaceInfo) => void;
  onSessionSelect: (session: SessionInfo) => void;
  onNewSession: () => void;
  onNewWorkspace: () => void;
}

// Generate a consistent color for a workspace based on its name
function getWorkspaceColor(name: string): string {
  const colors = [
    "#3b82f6", // blue
    "#8b5cf6", // violet
    "#ec4899", // pink
    "#f59e0b", // amber
    "#10b981", // emerald
    "#06b6d4", // cyan
    "#f97316", // orange
    "#6366f1", // indigo
    "#14b8a6", // teal
    "#a855f7", // purple
  ];

  // Simple hash function for consistent color selection
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function WorkspaceIcon({
  workspace,
  isActive,
  onClick,
}: {
  workspace: WorkspaceInfo;
  isActive: boolean;
  onClick: () => void;
}) {
  const initial = workspace.name.charAt(0).toUpperCase();
  const color = getWorkspaceColor(workspace.name);

  return (
    <button
      onClick={onClick}
      className={`w-12 h-12 rounded-lg flex items-center justify-center text-white font-semibold text-lg transition-all ${
        isActive ? "ring-2 ring-white ring-offset-2 ring-offset-gray-800" : "hover:opacity-80"
      }`}
      style={{ backgroundColor: color }}
      title={workspace.name}
    >
      {initial}
    </button>
  );
}

function SessionCard({
  session,
  isActive,
  onClick,
}: {
  session: SessionInfo;
  isActive: boolean;
  onClick: () => void;
}) {
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const formatName = (s: SessionInfo) => {
    if (s.firstPrompt) return s.firstPrompt;
    if (s.gitBranch) return s.gitBranch;
    return s.sessionId.slice(0, 8);
  };

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
        isActive
          ? "bg-blue-100 text-blue-900"
          : "hover:bg-gray-100 text-gray-700 hover:text-gray-900"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{formatName(session)}</div>
          {session.gitBranch && (
            <div className="text-xs text-gray-500 font-mono truncate">{session.gitBranch}</div>
          )}
        </div>
        <div className="text-xs text-gray-400 flex-shrink-0">
          {formatTime(session.modified || session.created || "")}
        </div>
      </div>
    </button>
  );
}

export function NavigationDrawer({
  workspaces,
  sessions,
  activeWorkspace,
  activeSessionId,
  isConnected,
  onWorkspaceSelect,
  onSessionSelect,
  onNewSession,
  onNewWorkspace,
}: NavigationDrawerProps) {
  const SESSION_PANEL_COLLAPSED_KEY = "claudia:nav:sessionsCollapsed";

  const [isPanelCollapsed, setIsPanelCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SESSION_PANEL_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_PANEL_COLLAPSED_KEY, String(isPanelCollapsed));
    } catch {
      // ignore localStorage errors
    }
  }, [isPanelCollapsed]);

  return (
    <>
      {/* Left sidebar - Workspace icons */}
      <div className="w-20 bg-gray-800 flex flex-col items-center py-4 gap-3 flex-shrink-0">
        {/* Workspace icons */}
        <div className="flex-1 flex flex-col gap-3 overflow-y-auto">
          {workspaces.map((workspace) => (
            <WorkspaceIcon
              key={workspace.id}
              workspace={workspace}
              isActive={activeWorkspace?.id === workspace.id}
              onClick={() => onWorkspaceSelect(workspace)}
            />
          ))}
        </div>

        {/* Add workspace button */}
        <button
          onClick={onNewWorkspace}
          className="w-12 h-12 rounded-lg border-2 border-dashed border-gray-600 hover:border-gray-400 flex items-center justify-center text-gray-400 hover:text-gray-300 transition-colors"
          title="New workspace"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>

      {/* Middle panel - Session list */}
      <div
        className={`bg-white border-r border-gray-200 flex flex-col transition-all duration-200 flex-shrink-0 ${
          isPanelCollapsed ? "w-0" : "w-64"
        }`}
      >
        {/* Panel header */}
        {!isPanelCollapsed && (
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-gray-900 truncate">
                {activeWorkspace?.name || "Select a workspace"}
              </h2>
              {activeWorkspace && (
                <button
                  onClick={onNewSession}
                  className="p-1 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors"
                  title="New session"
                >
                  <Plus className="w-5 h-5" />
                </button>
              )}
            </div>
            {activeWorkspace && (
              <p className="text-xs text-gray-500 truncate">{activeWorkspace.cwdDisplay}</p>
            )}
          </div>
        )}

        {/* Session list */}
        {!isPanelCollapsed && (
          <div className="flex-1 overflow-y-auto p-2">
            {activeWorkspace ? (
              sessions.length > 0 ? (
                <div className="space-y-1">
                  {sessions.map((session) => (
                    <SessionCard
                      key={session.sessionId}
                      session={session}
                      isActive={activeSessionId === session.sessionId}
                      onClick={() => onSessionSelect(session)}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-gray-500">
                  No sessions yet
                </div>
              )
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-gray-500">
                Select a workspace to view sessions
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collapse/Expand button */}
      <button
        onClick={() => setIsPanelCollapsed(!isPanelCollapsed)}
        className="fixed top-4 z-10 w-6 h-6 bg-white border border-gray-300 rounded-full flex items-center justify-center text-gray-600 hover:text-gray-900 hover:border-gray-400 transition-all shadow-sm"
        style={{ left: isPanelCollapsed ? "80px" : "336px" }}
        title={isPanelCollapsed ? "Show sessions" : "Hide sessions"}
      >
        {isPanelCollapsed ? (
          <ChevronRight className="w-4 h-4" />
        ) : (
          <ChevronLeft className="w-4 h-4" />
        )}
      </button>
    </>
  );
}
