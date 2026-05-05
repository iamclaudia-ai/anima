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
  /** Sessions keyed by workspace.id. Empty array if not loaded yet. */
  sessionsByWorkspace: Record<string, SessionInfo[]>;
  /** Whether each workspace has more sessions on the server, keyed by workspace.id. */
  hasMoreByWorkspace: Record<string, boolean>;
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
  /** Create a new session in `workspace` (defaults to the active one). */
  onNewSession: (workspace?: WorkspaceInfo) => void;
  onNewWorkspace: () => void;
  onCloseCreateWorkspaceModal: () => void;
  onCreateWorkspace: (cwd: string, name?: string, general?: boolean) => Promise<void>;
  onGetDirectories: (path: string) => Promise<{ path: string; directories: string[] }>;
  /**
   * Fetch the next page of sessions for a workspace and append to the cache.
   * Idempotent — caller can spam-click "Show more" without duplicating loads.
   */
  onLoadMoreSessions: (workspaceId: string) => Promise<void>;
  /** Toggle the workspace's pinned flag and re-sort the workspace list. */
  onPinWorkspace: (workspace: WorkspaceInfo, pinned: boolean) => Promise<void>;
  /**
   * Re-scan filesystem transcripts for a workspace and replace its session
   * cache with the freshly-discovered first page. `session.list_sessions`
   * already calls `discoverSessions` + upserts under the hood, so this is
   * just a forced re-fetch from the UI's perspective.
   */
  onRefreshSessions: (workspace: WorkspaceInfo) => Promise<void>;
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
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, SessionInfo[]>>({});
  const [hasMoreByWorkspace, setHasMoreByWorkspace] = useState<Record<string, boolean>>({});
  const loadingMoreRef = useRef<Set<string>>(new Set());
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showCreateWorkspaceModal, setShowCreateWorkspaceModal] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const { call, isConnected } = useGatewayClient();
  const activeWorkspaceRef = useRef<WorkspaceInfo | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

  // Active workspace's sessions — derived. Used by URL-driven session
  // selection ("latest" → most recent of the active workspace).
  const activeWorkspaceSessions = activeWorkspace
    ? (sessionsByWorkspace[activeWorkspace.id] ?? [])
    : [];

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

  // Initial page size for each workspace's session list. "Show more" fetches
  // another page of the same size. Tuned to the NavigationDrawer's default
  // visible-session count.
  const SESSIONS_PAGE_SIZE = 5;

  // Replace just one workspace's sessions + hasMore (immutable update).
  const setSessionsForWorkspace = useCallback(
    (workspaceId: string, sessions: SessionInfo[], hasMore: boolean) => {
      setSessionsByWorkspace((prev) => ({ ...prev, [workspaceId]: sessions }));
      setHasMoreByWorkspace((prev) => ({ ...prev, [workspaceId]: hasMore }));
    },
    [],
  );

  // Bootstrap: load workspaces, then fan out a parallel paginated
  // `session.list_sessions` for each so the new NavigationDrawer renders
  // every workspace's first page immediately. Subsequent pages load via
  // `onLoadMoreSessions` when the user clicks "Show more".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const wsResult = await callGateway<{ workspaces?: WorkspaceInfo[] }>(
          "session.list_workspaces",
        );
        if (cancelled) return;
        const list = wsResult?.workspaces ?? [];
        setWorkspaces(list);

        // Pick the active workspace from URL or fall back to first.
        const initialActive =
          (workspaceId ? list.find((w) => w.id === workspaceId) : null) ?? list[0] ?? null;
        if (initialActive && !activeWorkspaceRef.current) {
          setActiveWorkspace(initialActive);
          activeWorkspaceRef.current = initialActive;
        }

        // Fan out per-workspace first-page loads in parallel.
        const entries = await Promise.all(
          list.map(async (ws) => {
            const result = await loadSessionsForWorkspace(callGateway, ws.cwd, {
              limit: SESSIONS_PAGE_SIZE,
              offset: 0,
            }).catch(() => ({ sessions: [] as SessionInfo[], total: 0, hasMore: false }));
            return [ws.id, result] as const;
          }),
        );
        if (cancelled) return;
        setSessionsByWorkspace(Object.fromEntries(entries.map(([id, r]) => [id, r.sessions])));
        setHasMoreByWorkspace(Object.fromEntries(entries.map(([id, r]) => [id, r.hasMore])));

        // Resolve active session from URL.
        if (sessionId && sessionId !== "latest" && !activeSessionIdRef.current) {
          setActiveSessionId(sessionId);
        }
      } catch {
        // ignore bootstrap errors; connection status handled by gateway hook
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callGateway, workspaceId, sessionId]);

  const onLoadMoreSessions = useCallback(
    async (workspaceId: string) => {
      // Idempotent — bail if we're already fetching for this workspace.
      if (loadingMoreRef.current.has(workspaceId)) return;
      const ws = workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      const current = sessionsByWorkspace[workspaceId] ?? [];
      loadingMoreRef.current.add(workspaceId);
      try {
        const next = await loadSessionsForWorkspace(callGateway, ws.cwd, {
          limit: SESSIONS_PAGE_SIZE,
          offset: current.length,
        });
        setSessionsByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: [...(prev[workspaceId] ?? []), ...next.sessions],
        }));
        setHasMoreByWorkspace((prev) => ({ ...prev, [workspaceId]: next.hasMore }));
      } catch {
        // best-effort; user can click again
      } finally {
        loadingMoreRef.current.delete(workspaceId);
      }
    },
    [callGateway, workspaces, sessionsByWorkspace],
  );

  const onWorkspaceSelect = useCallback(
    (workspace: WorkspaceInfo) => {
      setActiveWorkspace(workspace);
      activeWorkspaceRef.current = workspace;
      setActiveSessionId(null);
      navigate(`/workspace/${workspace.id}/session/latest`);
      // Refresh first page in case anything changed externally.
      void loadSessionsForWorkspace(callGateway, workspace.cwd, {
        limit: SESSIONS_PAGE_SIZE,
        offset: 0,
      })
        .then((result) => setSessionsForWorkspace(workspace.id, result.sessions, result.hasMore))
        .catch(() => undefined);
    },
    [callGateway, setSessionsForWorkspace],
  );

  const onSessionSelect = useCallback((session: SessionInfo) => {
    setActiveSessionId(session.sessionId);
    if (activeWorkspaceRef.current) {
      navigate(`/workspace/${activeWorkspaceRef.current.id}/session/${session.sessionId}`);
    }
  }, []);

  const onNewSession = useCallback(
    (workspace?: WorkspaceInfo) => {
      const target = workspace ?? activeWorkspaceRef.current;
      if (!target) return;
      void createSessionForWorkspace(callGateway, target.cwd)
        .then((nextSessionId) => {
          if (!nextSessionId) return;
          // Selecting and navigating to the new session — same workspace as
          // the create (whether it's the active one or not).
          setActiveWorkspace(target);
          activeWorkspaceRef.current = target;
          setActiveSessionId(nextSessionId);
          navigate(`/workspace/${target.id}/session/${nextSessionId}`);
          const optimistic: SessionInfo = {
            sessionId: nextSessionId,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
          };
          setSessionsByWorkspace((prev) => ({
            ...prev,
            [target.id]: mergeSessionsPreferLocal(
              [],
              [optimistic, ...(prev[target.id] ?? [])],
              nextSessionId,
            ),
          }));
          // Reconcile with the server in the background — refresh just the
          // first page; older sessions stay paged out until "Show more".
          return loadSessionsForWorkspace(callGateway, target.cwd, {
            limit: SESSIONS_PAGE_SIZE,
            offset: 0,
          }).then((result) => {
            setSessionsByWorkspace((prev) => ({
              ...prev,
              [target.id]: mergeSessionsPreferLocal(
                result.sessions,
                prev[target.id] ?? [],
                nextSessionId,
              ),
            }));
            setHasMoreByWorkspace((prev) => ({ ...prev, [target.id]: result.hasMore }));
          });
        })
        .catch(() => undefined);
    },
    [callGateway],
  );

  const onNewWorkspace = useCallback(() => setShowCreateWorkspaceModal(true), []);
  const onCloseCreateWorkspaceModal = useCallback(() => setShowCreateWorkspaceModal(false), []);

  const onRefreshSessions = useCallback(
    async (workspace: WorkspaceInfo) => {
      try {
        const result = await loadSessionsForWorkspace(callGateway, workspace.cwd, {
          limit: SESSIONS_PAGE_SIZE,
          offset: 0,
        });
        setSessionsForWorkspace(workspace.id, result.sessions, result.hasMore);
      } catch (error) {
        console.error("Failed to refresh sessions", error);
      }
    },
    [callGateway, setSessionsForWorkspace],
  );

  const onPinWorkspace = useCallback(
    async (workspace: WorkspaceInfo, pinned: boolean) => {
      // Optimistic flip so the dot + sort order update immediately;
      // the server is the source of truth so we re-fetch to settle.
      setWorkspaces((prev) => {
        const next = prev.map((w) => (w.id === workspace.id ? { ...w, pinned } : w));
        // Re-sort: pinned first, then by updatedAt desc — match server ordering.
        return next.sort((a, b) => {
          if ((a.pinned ?? false) !== (b.pinned ?? false)) return a.pinned ? -1 : 1;
          return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        });
      });
      try {
        await callGateway("session.set_workspace_pinned", { id: workspace.id, pinned });
        // Refresh from server to ensure we match canonical ordering.
        const wsResult = await callGateway<{ workspaces?: WorkspaceInfo[] }>(
          "session.list_workspaces",
        );
        if (wsResult?.workspaces) setWorkspaces(wsResult.workspaces);
      } catch (error) {
        console.error("Failed to pin workspace", error);
        // Revert on failure.
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === workspace.id ? { ...w, pinned: !pinned } : w)),
        );
      }
    },
    [callGateway],
  );

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
        const existingPage = await loadSessionsForWorkspace(callGateway, newWorkspace.cwd, {
          limit: SESSIONS_PAGE_SIZE,
          offset: 0,
        });
        const existingSessions = existingPage.sessions;

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

        const reconciled =
          existingSessions.length > 0
            ? { sessions: existingSessions, hasMore: existingPage.hasMore }
            : await loadSessionsForWorkspace(callGateway, newWorkspace.cwd, {
                limit: SESSIONS_PAGE_SIZE,
                offset: 0,
              }).then((result) => ({
                sessions: mergeSessionsPreferLocal(
                  result.sessions,
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
                hasMore: result.hasMore,
              }));
        setSessionsForWorkspace(newWorkspace.id, reconciled.sessions, reconciled.hasMore);

        setShowCreateWorkspaceModal(false);
      } catch (error) {
        console.error("Failed to create workspace:", error);
      } finally {
        setIsCreatingWorkspace(false);
      }
    },
    [callGateway, setSessionsForWorkspace],
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
      } else if (activeWorkspaceSessions.length > 0) {
        const mostRecent = activeWorkspaceSessions[0];
        if (mostRecent && mostRecent.sessionId !== activeSessionId) {
          setActiveSessionId(mostRecent.sessionId);
        }
      } else {
        setActiveSessionId(null);
      }
    } else if (sessionId && sessionId !== "latest" && sessionId !== activeSessionId) {
      setActiveSessionId(sessionId);
    }
  }, [sessionId, activeSessionId, workspaceId, activeWorkspaceSessions]);

  // Handle workspace prop change — refresh first page for the workspace the
  // URL is now pointing at (covers external nav like a deep link).
  useEffect(() => {
    if (workspaceId && workspaces.length > 0) {
      const targetWorkspace = workspaces.find((ws) => ws.id === workspaceId);
      if (targetWorkspace && targetWorkspace.id !== activeWorkspace?.id) {
        setActiveWorkspace(targetWorkspace);
        activeWorkspaceRef.current = targetWorkspace;
        void loadSessionsForWorkspace(callGateway, targetWorkspace.cwd, {
          limit: SESSIONS_PAGE_SIZE,
          offset: 0,
        })
          .then((result) =>
            setSessionsForWorkspace(targetWorkspace.id, result.sessions, result.hasMore),
          )
          .catch(() => undefined);
      }
    }
  }, [workspaceId, workspaces, activeWorkspace, callGateway, setSessionsForWorkspace]);

  const value = useMemo<ChatPageContextValue>(
    () => ({
      workspaces,
      sessionsByWorkspace,
      hasMoreByWorkspace,
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
      onLoadMoreSessions,
      onPinWorkspace,
      onRefreshSessions,
    }),
    [
      workspaces,
      sessionsByWorkspace,
      hasMoreByWorkspace,
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
      onLoadMoreSessions,
      onPinWorkspace,
      onRefreshSessions,
    ],
  );

  return <ChatPageContext.Provider value={value}>{children}</ChatPageContext.Provider>;
}
