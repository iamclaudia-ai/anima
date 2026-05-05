/**
 * ChatPageContext — Hoists workspace/session state out of MainPage so the
 * NavigationDrawer panel and the ClaudiaChat panel can render in separate
 * dockview tiles while still sharing one source of truth.
 *
 * The provider runs once per route mount (installed via
 * `LayoutDefinition.provider`), owns all the gateway calls and URL syncing
 * that used to live in MainPage, and exposes both data and handlers via the
 * `useChatPage` hook.
 *
 * Splitting rationale: the previous setup had every piece of state local to
 * MainPage, which meant any decomposition into separate panels would have
 * required either prop-drilling through dockview (impossible — panels are
 * rendered by ID, not as React children) or duplicating the gateway calls in
 * each panel. The provider pattern keeps the call paths single.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { navigate, useGatewayClient, useRouter } from "@anima/ui";
import type { WorkspaceInfo, SessionInfo } from "@anima/ui";
import { createBridge } from "../app";
import {
  createSessionForWorkspace,
  loadMainPageBootstrapData,
  loadSessionsForWorkspace,
} from "../pages/helpers/main-page-gateway";

// ── Local helpers ─────────────────────────────────────────────

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

function getLatestSessionId(workspaceId: string): string | null {
  try {
    return localStorage.getItem(`anima:workspace:${workspaceId}:latestSession`);
  } catch {
    return null;
  }
}

function setLatestSessionId(workspaceId: string, sessionId: string): void {
  try {
    localStorage.setItem(`anima:workspace:${workspaceId}:latestSession`, sessionId);
  } catch {
    // ignore localStorage errors
  }
}

// ── Context shape ─────────────────────────────────────────────

export interface ChatPageContextValue {
  // Data
  workspaces: WorkspaceInfo[];
  sessions: SessionInfo[];
  activeWorkspace: WorkspaceInfo | null;
  activeSessionId: string | null;
  isConnected: boolean;
  // biome-ignore lint: Bridge has many shapes depending on extension wiring
  chatBridge: ReturnType<typeof createBridge>;

  // Modal state
  showCreateWorkspaceModal: boolean;
  isCreatingWorkspace: boolean;

  // Handlers — all the actions a panel can take
  onWorkspaceSelect: (workspace: WorkspaceInfo) => void;
  onSessionSelect: (session: SessionInfo) => void;
  onNewSession: () => void;
  onNewWorkspace: () => void;
  onCloseCreateWorkspaceModal: () => void;
  onCreateWorkspace: (cwd: string, name?: string, general?: boolean) => Promise<void>;
  onGetDirectories: (path: string) => Promise<{ path: string; directories: string[] }>;
}

const ChatPageContext = createContext<ChatPageContextValue | null>(null);

export function useChatPage(): ChatPageContextValue {
  const value = useContext(ChatPageContext);
  if (!value) {
    throw new Error("useChatPage must be used within a ChatPageProvider");
  }
  return value;
}

// ── Provider ──────────────────────────────────────────────────

export function ChatPageProvider({ children }: { children: ReactNode }) {
  // Pull route params from the router (the layout's parent provides these).
  const { params } = useRouter();
  const workspaceId = params.workspaceId;
  const sessionId = params.sessionId;

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

  // Bootstrap on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
    })();
    return () => {
      cancelled = true;
    };
  }, [callGateway, workspaceId, sessionId]);

  const onWorkspaceSelect = useCallback(
    (workspace: WorkspaceInfo) => {
      setActiveWorkspace(workspace);
      activeWorkspaceRef.current = workspace;
      setActiveSessionId(null);
      setSessions([]);
      navigate(`/workspace/${workspace.id}/session/latest`);
      void loadSessionsForWorkspace(callGateway, workspace.cwd)
        .then((payload) => setSessions(payload))
        .catch(() => undefined);
    },
    [callGateway],
  );

  const onSessionSelect = useCallback((session: SessionInfo) => {
    setActiveSessionId(session.sessionId);
    if (activeWorkspaceRef.current) {
      navigate(`/workspace/${activeWorkspaceRef.current.id}/session/${session.sessionId}`);
    }
  }, []);

  const onNewSession = useCallback(() => {
    if (!activeWorkspaceRef.current) return;
    const workspace = activeWorkspaceRef.current;
    void createSessionForWorkspace(callGateway, workspace.cwd)
      .then((payload) => {
        const nextSessionId = payload;
        if (!nextSessionId) return;
        setActiveSessionId(nextSessionId);
        navigate(`/workspace/${workspace.id}/session/${nextSessionId}`);
        const optimisticSession: SessionInfo = {
          sessionId: nextSessionId,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
        };
        setSessions((prev) =>
          mergeSessionsPreferLocal([], [optimisticSession, ...prev], nextSessionId),
        );
        return loadSessionsForWorkspace(callGateway, workspace.cwd).then((sessionsPayload) => {
          setSessions((prev) => mergeSessionsPreferLocal(sessionsPayload, prev, nextSessionId));
        });
      })
      .catch(() => undefined);
  }, [callGateway]);

  const onNewWorkspace = useCallback(() => setShowCreateWorkspaceModal(true), []);
  const onCloseCreateWorkspaceModal = useCallback(() => setShowCreateWorkspaceModal(false), []);

  const onGetDirectories = useCallback(
    async (path: string): Promise<{ path: string; directories: string[] }> => {
      const result = await callGateway<{ path: string; directories: string[] }>(
        "session.get_directories",
        { path },
      );
      return result || { path, directories: [] };
    },
    [callGateway],
  );

  const onCreateWorkspace = useCallback(
    async (cwd: string, name?: string, general?: boolean) => {
      setIsCreatingWorkspace(true);
      try {
        const wsResult = await callGateway<{ workspace: WorkspaceInfo; created: boolean }>(
          "session.get_or_create_workspace",
          { cwd, name, general },
        );
        if (!wsResult?.workspace) {
          setIsCreatingWorkspace(false);
          return;
        }

        const newWorkspace = wsResult.workspace;
        const existingSessions = await loadSessionsForWorkspace(callGateway, newWorkspace.cwd);

        let sessionIdToUse: string;
        if (existingSessions.length > 0) {
          sessionIdToUse = existingSessions[0].sessionId;
        } else {
          const sessionResult = await callGateway<{ sessionId: string }>("session.create_session", {
            cwd: newWorkspace.cwd,
          });
          if (!sessionResult?.sessionId) {
            setIsCreatingWorkspace(false);
            return;
          }
          sessionIdToUse = sessionResult.sessionId;
        }

        const workspacesResult = await callGateway<{ workspaces: WorkspaceInfo[] }>(
          "session.list_workspaces",
        );
        if (workspacesResult?.workspaces) {
          setWorkspaces(workspacesResult.workspaces);
        }

        setActiveWorkspace(newWorkspace);
        activeWorkspaceRef.current = newWorkspace;
        setActiveSessionId(sessionIdToUse);
        navigate(`/workspace/${newWorkspace.id}/session/${sessionIdToUse}`);

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

        setShowCreateWorkspaceModal(false);
      } catch (error) {
        console.error("Failed to create workspace:", error);
      } finally {
        setIsCreatingWorkspace(false);
      }
    },
    [callGateway],
  );

  // Persist active session as the workspace's "latest"
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      setLatestSessionId(activeWorkspace.id, activeSessionId);
    }
  }, [activeSessionId, activeWorkspace]);

  // Sync URL after bootstrap resolves
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      const target = `/workspace/${activeWorkspace.id}/session/${activeSessionId}`;
      if (window.location.pathname !== target) {
        window.history.replaceState(null, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    }
  }, [activeSessionId, activeWorkspace]);

  // Handle "latest" session resolution + URL-driven session switches
  useEffect(() => {
    if (sessionId === "latest" && workspaceId) {
      if (activeSessionId) return;
      const latestSessionId = getLatestSessionId(workspaceId);
      if (latestSessionId) {
        setActiveSessionId(latestSessionId);
      } else if (sessions.length > 0) {
        const mostRecent = sessions[0];
        if (mostRecent && mostRecent.sessionId !== activeSessionId) {
          setActiveSessionId(mostRecent.sessionId);
        }
      } else {
        setActiveSessionId(null);
      }
    } else if (sessionId && sessionId !== "latest" && sessionId !== activeSessionId) {
      setActiveSessionId(sessionId);
    }
  }, [sessionId, activeSessionId, workspaceId, sessions]);

  // Handle workspace prop change
  useEffect(() => {
    if (workspaceId && workspaces.length > 0) {
      const targetWorkspace = workspaces.find((ws) => ws.id === workspaceId);
      if (targetWorkspace && targetWorkspace.id !== activeWorkspace?.id) {
        setActiveWorkspace(targetWorkspace);
        activeWorkspaceRef.current = targetWorkspace;
        void loadSessionsForWorkspace(callGateway, targetWorkspace.cwd)
          .then((payload) => setSessions(payload))
          .catch(() => undefined);
      }
    }
  }, [workspaceId, workspaces, activeWorkspace, callGateway]);

  const value = useMemo<ChatPageContextValue>(
    () => ({
      workspaces,
      sessions,
      activeWorkspace,
      activeSessionId,
      isConnected,
      chatBridge,
      showCreateWorkspaceModal,
      isCreatingWorkspace,
      onWorkspaceSelect,
      onSessionSelect,
      onNewSession,
      onNewWorkspace,
      onCloseCreateWorkspaceModal,
      onCreateWorkspace,
      onGetDirectories,
    }),
    [
      workspaces,
      sessions,
      activeWorkspace,
      activeSessionId,
      isConnected,
      chatBridge,
      showCreateWorkspaceModal,
      isCreatingWorkspace,
      onWorkspaceSelect,
      onSessionSelect,
      onNewSession,
      onNewWorkspace,
      onCloseCreateWorkspaceModal,
      onCreateWorkspace,
      onGetDirectories,
    ],
  );

  return <ChatPageContext.Provider value={value}>{children}</ChatPageContext.Provider>;
}
