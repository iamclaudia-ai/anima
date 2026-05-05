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
  /**
   * Select a session. The workspace is carried explicitly because session
   * rows live under their workspace in the drawer — using the URL's current
   * workspace would mis-route clicks across workspaces.
   */
  onSessionSelect: (session: SessionInfo, workspace: WorkspaceInfo) => void;
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
  const [showCreateWorkspaceModal, setShowCreateWorkspaceModal] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const { call, isConnected } = useGatewayClient();

  // ── URL is the single source of truth ────────────────────────
  // `activeWorkspace` and `activeSessionId` are *derived* from the URL.
  // Handlers never write them directly — they only call `navigate()`,
  // which updates the URL, which re-renders this component with new
  // `params`, which re-derives these values. One direction, one writer.
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );
  // `latest` in the URL is a sentinel — the redirect effect below resolves
  // it to a real sessionId (via `replaceState`), so for state purposes we
  // treat `latest` as "no active session yet."
  const activeSessionId = useMemo(
    () => (sessionId && sessionId !== "latest" ? sessionId : null),
    [sessionId],
  );

  // Active workspace's sessions — derived. Used by the "latest" redirect
  // effect to pick the most recent session for the URL workspace.
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
  //
  // No URL/state syncing here — this effect is purely about fetching data.
  // Active selection is derived from the URL above; the redirect effect
  // below handles `/` and `/session/latest` resolution.
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
      } catch {
        // ignore bootstrap errors; connection status handled by gateway hook
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callGateway]);

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

  // Selection handlers are URL-only: they navigate, and the URL→state
  // derivation above does the rest. No imperative setActive* calls.
  const onWorkspaceSelect = useCallback(
    (workspace: WorkspaceInfo) => {
      navigate(`/workspace/${workspace.id}/session/latest`);
      // Best-effort refresh of the first page in case anything changed
      // externally — purely a data fetch, doesn't touch selection.
      void loadSessionsForWorkspace(callGateway, workspace.cwd, {
        limit: SESSIONS_PAGE_SIZE,
        offset: 0,
      })
        .then((result) => setSessionsForWorkspace(workspace.id, result.sessions, result.hasMore))
        .catch(() => undefined);
    },
    [callGateway, setSessionsForWorkspace],
  );

  const onSessionSelect = useCallback((session: SessionInfo, workspace: WorkspaceInfo) => {
    // Use the click's workspace, not the URL's. Otherwise clicking a
    // session in a different workspace's drawer section would build a URL
    // that mismatches the session's actual workspace, leaving the Header
    // and the active-row highlight stuck on the previous workspace.
    navigate(`/workspace/${workspace.id}/session/${session.sessionId}`);
  }, []);

  const onNewSession = useCallback(
    (workspace?: WorkspaceInfo) => {
      const target = workspace ?? activeWorkspace;
      if (!target) return;
      void createSessionForWorkspace(callGateway, target.cwd)
        .then((nextSessionId) => {
          if (!nextSessionId) return;
          // Optimistic insert into the workspace's session list — keeps the
          // nav drawer responsive while the server reconciles.
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
          // Navigate — URL change drives selection.
          navigate(`/workspace/${target.id}/session/${nextSessionId}`);
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
    [callGateway, activeWorkspace],
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

        // Navigate — URL change drives selection.
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

  // Persist active session as the workspace's "latest" so re-entering the
  // workspace via `/workspace/<id>/session/latest` lands on the same one.
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      setLatestSessionId(activeWorkspace.id, activeSessionId);
    }
  }, [activeSessionId, activeWorkspace]);

  // ── URL redirects (single writer) ────────────────────────────
  // Resolve `/`, `/workspace/<id>`, and `/workspace/<id>/session/latest`
  // to a concrete URL. Uses `replace: true` so the placeholder doesn't
  // pollute the back-button history.
  useEffect(() => {
    if (workspaces.length === 0) return;

    // No workspace in the URL → land on the first one's latest session.
    if (!workspaceId) {
      const first = workspaces[0];
      if (first) navigate(`/workspace/${first.id}/session/latest`, { replace: true });
      return;
    }

    // Workspace in URL but no session → resolve to latest.
    if (workspaceId && !sessionId) {
      navigate(`/workspace/${workspaceId}/session/latest`, { replace: true });
      return;
    }

    // `latest` sentinel → resolve once we know what "latest" means.
    if (sessionId === "latest") {
      const remembered = getLatestSessionId(workspaceId);
      const fallback = activeWorkspaceSessions[0]?.sessionId;
      const resolved = remembered ?? fallback;
      if (resolved) {
        navigate(`/workspace/${workspaceId}/session/${resolved}`, { replace: true });
      }
      // If nothing's loaded yet we just leave `latest` in the URL — the
      // bootstrap fetch will populate `activeWorkspaceSessions` and this
      // effect will re-run.
    }
  }, [workspaceId, sessionId, workspaces, activeWorkspaceSessions]);

  // Refresh first page when the URL points at a new workspace — purely
  // a data fetch, doesn't touch selection. Decoupling this from the
  // bootstrap effect keeps deep-link navigation responsive.
  useEffect(() => {
    if (!activeWorkspace) return;
    void loadSessionsForWorkspace(callGateway, activeWorkspace.cwd, {
      limit: SESSIONS_PAGE_SIZE,
      offset: 0,
    })
      .then((result) =>
        setSessionsForWorkspace(activeWorkspace.id, result.sessions, result.hasMore),
      )
      .catch(() => undefined);
  }, [activeWorkspace, callGateway, setSessionsForWorkspace]);

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
