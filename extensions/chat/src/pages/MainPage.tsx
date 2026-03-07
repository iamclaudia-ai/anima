import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  ClaudiaChat,
  NavigationDrawer,
  CreateWorkspaceModal,
  navigate,
  useGatewayClient,
} from "@claudia/ui";
import type { WorkspaceInfo, SessionInfo } from "@claudia/ui";
import { createBridge } from "../app";
import {
  createSessionForWorkspace,
  loadMainPageBootstrapData,
  loadSessionsForWorkspace,
} from "./helpers/main-page-gateway";

function mergeSessionsPreferLocal(
  remote: SessionInfo[],
  local: SessionInfo[],
  preferredSessionId?: string,
): SessionInfo[] {
  const merged = new Map<string, SessionInfo>();
  for (const session of remote) merged.set(session.sessionId, session);
  for (const session of local) {
    if (!merged.has(session.sessionId)) merged.set(session.sessionId, session);
  }

  const list = Array.from(merged.values());
  list.sort((a, b) => {
    const aTime = a.modified || a.created || "";
    const bTime = b.modified || b.created || "";
    return bTime.localeCompare(aTime);
  });

  if (preferredSessionId) {
    const idx = list.findIndex((s) => s.sessionId === preferredSessionId);
    if (idx > 0) {
      const [preferred] = list.splice(idx, 1);
      if (preferred) list.unshift(preferred);
    }
  }

  return list;
}

// Get latest session ID for a workspace from localStorage
function getLatestSessionId(workspaceId: string): string | null {
  try {
    return localStorage.getItem(`claudia:workspace:${workspaceId}:latestSession`);
  } catch {
    return null;
  }
}

// Save latest session ID for a workspace to localStorage
function setLatestSessionId(workspaceId: string, sessionId: string): void {
  try {
    localStorage.setItem(`claudia:workspace:${workspaceId}:latestSession`, sessionId);
  } catch {
    // ignore localStorage errors
  }
}

export function MainPage({ workspaceId, sessionId }: { workspaceId?: string; sessionId?: string }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showCreateWorkspaceModal, setShowCreateWorkspaceModal] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const { call, isConnected } = useGatewayClient();
  const activeWorkspaceRef = useRef<WorkspaceInfo | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const chatBridge = useMemo(
    () =>
      createBridge({
        workspaceId: activeWorkspace?.id,
        sessionId: activeSessionId || undefined,
      }),
    [activeWorkspace?.id, activeSessionId],
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const callGateway = useCallback(
    async <T,>(method: string, params?: Record<string, unknown>): Promise<T | null> => {
      return (await call<T>(method, params)) as T;
    },
    [call],
  );

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const data = await loadMainPageBootstrapData(callGateway, {
          workspaceId,
          sessionId,
          hasActiveSession: activeSessionIdRef.current !== null,
        });
        if (cancelled) return;
        setWorkspaces(data.workspaces);
        setSessions(data.sessions);
        if (!activeWorkspaceRef.current && data.activeWorkspace) {
          setActiveWorkspace(data.activeWorkspace);
          activeWorkspaceRef.current = data.activeWorkspace;
        }
        if (data.activeSessionId) {
          setActiveSessionId(data.activeSessionId);
        }
      } catch {
        // ignore bootstrap errors; connection status handled by gateway hook
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [callGateway]);

  const handleWorkspaceSelect = useCallback(
    (workspace: WorkspaceInfo) => {
      setActiveWorkspace(workspace);
      activeWorkspaceRef.current = workspace;
      setActiveSessionId(null);
      setSessions([]);
      // Navigate to workspace's latest session
      navigate(`/workspace/${workspace.id}/session/latest`);
      void loadSessionsForWorkspace(callGateway, workspace.cwd)
        .then((payload) => {
          setSessions(payload);
        })
        .catch(() => undefined);
    },
    [callGateway],
  );

  const handleSessionSelect = useCallback((session: SessionInfo) => {
    setActiveSessionId(session.sessionId);
    // Update URL to reflect current workspace/session
    if (activeWorkspaceRef.current) {
      navigate(`/workspace/${activeWorkspaceRef.current.id}/session/${session.sessionId}`);
    }
  }, []);

  const handleNewSession = useCallback(() => {
    if (!activeWorkspaceRef.current) return;
    void createSessionForWorkspace(callGateway, activeWorkspaceRef.current.cwd)
      .then((payload) => {
        const nextSessionId = payload;
        if (!nextSessionId) return;
        setActiveSessionId(nextSessionId);
        const optimisticSession: SessionInfo = {
          sessionId: nextSessionId,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
        };
        setSessions((prev) =>
          mergeSessionsPreferLocal([], [optimisticSession, ...prev], nextSessionId),
        );
        if (!activeWorkspaceRef.current) return;
        return loadSessionsForWorkspace(callGateway, activeWorkspaceRef.current.cwd).then(
          (sessionsPayload) => {
            setSessions((prev) => mergeSessionsPreferLocal(sessionsPayload, prev, nextSessionId));
          },
        );
      })
      .catch(() => undefined);
  }, [callGateway]);

  // Save active session to localStorage as "latest" for this workspace
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      setLatestSessionId(activeWorkspace.id, activeSessionId);
    }
  }, [activeSessionId, activeWorkspace, sessionId]);

  // Update URL when new session is created
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      navigate(`/workspace/${activeWorkspace.id}/session/${activeSessionId}`);
    }
  }, [activeSessionId, activeWorkspace]);

  // Watch for prop changes (when router updates URL without re-mounting)
  useEffect(() => {
    // Handle "latest" session ID - resolve from localStorage or most recent session
    if (sessionId === "latest" && workspaceId) {
      // Keep current selection stable; only resolve "latest" when no active session is set yet.
      if (activeSessionId) return;

      const latestSessionId = getLatestSessionId(workspaceId);
      if (latestSessionId) {
        // Use stored latest session
        setActiveSessionId(latestSessionId);
      } else if (!latestSessionId && sessions.length > 0) {
        // No stored session, use most recent from list (already sorted by modified desc)
        const mostRecent = sessions[0];
        if (mostRecent.sessionId !== activeSessionId) {
          setActiveSessionId(mostRecent.sessionId);
        }
      } else if (sessions.length === 0) {
        // No sessions at all, show empty state
        setActiveSessionId(null);
      }
    }
    // If sessionId prop changes and differs from current state, update state
    else if (sessionId && sessionId !== "latest" && sessionId !== activeSessionId) {
      setActiveSessionId(sessionId);
    }
  }, [sessionId, activeSessionId, workspaceId, sessions]);

  // Watch for workspace prop changes
  useEffect(() => {
    if (workspaceId && workspaces.length > 0) {
      const targetWorkspace = workspaces.find((ws) => ws.id === workspaceId);
      if (targetWorkspace && targetWorkspace.id !== activeWorkspace?.id) {
        setActiveWorkspace(targetWorkspace);
        activeWorkspaceRef.current = targetWorkspace;
        void loadSessionsForWorkspace(callGateway, targetWorkspace.cwd)
          .then((payload) => {
            setSessions(payload);
          })
          .catch(() => undefined);
      }
    }
  }, [workspaceId, workspaces, activeWorkspace, callGateway]);

  const handleNewWorkspace = useCallback(() => {
    setShowCreateWorkspaceModal(true);
  }, []);

  const handleGetDirectories = useCallback(
    async (path: string): Promise<{ path: string; directories: string[] }> => {
      const result = await callGateway<{ path: string; directories: string[] }>(
        "session.get_directories",
        { path },
      );
      return result || { path, directories: [] };
    },
    [callGateway],
  );

  const handleCreateWorkspace = useCallback(
    async (cwd: string, name?: string) => {
      setIsCreatingWorkspace(true);
      try {
        // Create workspace (will create directory if it doesn't exist)
        const wsResult = await callGateway<{ workspace: WorkspaceInfo; created: boolean }>(
          "session.get_or_create_workspace",
          { cwd, name },
        );
        if (!wsResult?.workspace) {
          setIsCreatingWorkspace(false);
          return;
        }

        const newWorkspace = wsResult.workspace;

        // Check if workspace already has sessions
        const existingSessions = await loadSessionsForWorkspace(callGateway, newWorkspace.cwd);

        let sessionIdToUse: string;

        if (existingSessions.length > 0) {
          // Workspace already has sessions - use the most recent one
          sessionIdToUse = existingSessions[0].sessionId;
        } else {
          // No existing sessions - create the first one
          const sessionResult = await callGateway<{ sessionId: string }>("session.create_session", {
            cwd: newWorkspace.cwd,
          });

          if (!sessionResult?.sessionId) {
            setIsCreatingWorkspace(false);
            return;
          }
          sessionIdToUse = sessionResult.sessionId;
        }

        // Refresh workspaces list
        const workspacesResult = await callGateway<{ workspaces: WorkspaceInfo[] }>(
          "session.list_workspaces",
        );
        if (workspacesResult?.workspaces) {
          setWorkspaces(workspacesResult.workspaces);
        }

        // Navigate to the workspace/session
        setActiveWorkspace(newWorkspace);
        activeWorkspaceRef.current = newWorkspace;
        setActiveSessionId(sessionIdToUse);
        navigate(`/workspace/${newWorkspace.id}/session/${sessionIdToUse}`);

        // Load/refresh sessions for this workspace
        setSessions(
          existingSessions.length > 0
            ? existingSessions
            : mergeSessionsPreferLocal(
                await loadSessionsForWorkspace(callGateway, newWorkspace.cwd),
                sessionIdToUse
                  ? [
                      {
                        sessionId: sessionIdToUse,
                        created: new Date().toISOString(),
                        modified: new Date().toISOString(),
                      },
                    ]
                  : [],
                sessionIdToUse,
              ),
        );

        // Close modal
        setShowCreateWorkspaceModal(false);
      } catch (error) {
        console.error("Failed to create workspace:", error);
      } finally {
        setIsCreatingWorkspace(false);
      }
    },
    [callGateway],
  );

  return (
    <>
      <div className="flex h-screen w-screen overflow-x-hidden">
        <NavigationDrawer
          workspaces={workspaces}
          sessions={sessions}
          activeWorkspace={activeWorkspace}
          activeSessionId={activeSessionId}
          isConnected={isConnected}
          onWorkspaceSelect={handleWorkspaceSelect}
          onSessionSelect={handleSessionSelect}
          onNewSession={handleNewSession}
          onNewWorkspace={handleNewWorkspace}
        />

        {/* Main content area */}
        <div className="flex-1 bg-white min-w-0">
          {activeSessionId && activeWorkspace ? (
            <ClaudiaChat
              bridge={chatBridge}
              gatewayOptions={{ sessionId: activeSessionId, workspaceId: activeWorkspace.id }}
              key={`${activeWorkspace.id}-${activeSessionId}`}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <p className="text-gray-400">
                {activeWorkspace
                  ? "No sessions yet for this workspace"
                  : "Select a workspace to get started"}
              </p>
              {activeWorkspace && (
                <button
                  onClick={handleNewSession}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Create new session
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <CreateWorkspaceModal
        isOpen={showCreateWorkspaceModal}
        onClose={() => setShowCreateWorkspaceModal(false)}
        onSubmit={handleCreateWorkspace}
        onGetDirectories={handleGetDirectories}
        isCreating={isCreatingWorkspace}
      />
    </>
  );
}
