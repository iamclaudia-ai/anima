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
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { navigate, useGatewayClient, useRouter, WorkspaceProvider } from "@anima/ui";
import type {
  WorkspaceInfo,
  SessionInfo,
  SessionSearchResult,
  SessionActivityEvent,
  SessionStatusChangedEvent,
  SessionListChangedEvent,
  SessionDisposition,
} from "@anima/ui";
import { createBridge } from "../app";
import {
  createSessionForWorkspace,
  loadSessionsForWorkspace,
} from "../pages/helpers/main-page-gateway";

/**
 * The fields a status or activity event can move on a tree row. The two events
 * differ in *when* they fire, not in what they carry, so one patch handles both.
 */
type SessionRowPatch = Pick<
  SessionActivityEvent,
  "sessionId" | "runtimeStatus" | "disposition" | "title" | "firstPrompt"
> & { at?: string };

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
  onRenameSession: (session: SessionInfo, title: string | null) => Promise<void>;
  onSetSessionDisposition: (session: SessionInfo, disposition: SessionDisposition) => Promise<void>;
  /** Full-text search across every message in every workspace. */
  onSearchSessions: (query: string) => Promise<SessionSearchResult>;
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
  const value = use(ChatPageContext);
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
  const { call, client, isConnected } = useGatewayClient();

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

  // Read by the live-event effect. Held in refs rather than listed as
  // dependencies so a workspace list update doesn't tear down and rebuild the
  // gateway subscription — a resubscribe cycle can drop events landing in the
  // gap, which is exactly the staleness this is meant to remove.
  const workspacesRef = useRef<WorkspaceInfo[]>(workspaces);
  const sessionCountRef = useRef<Record<string, number>>({});
  // The refetch goes through a ref for the same reason as the data above:
  // naming it as an effect dependency would tear down and rebuild the gateway
  // subscription whenever its identity changed, and events landing in that gap
  // are lost — which is the staleness the subscription exists to fix.
  const refetchWorkspaceRef = useRef<(workspaceId: string) => void>(() => undefined);

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
      navigate(`/chat/${workspace.id}/latest`);
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
    navigate(`/chat/${workspace.id}/${session.sessionId}`);
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
          navigate(`/chat/${target.id}/${nextSessionId}`);
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

  const onRenameSession = useCallback(
    async (session: SessionInfo, title: string | null) => {
      const previous = session.title;
      // Optimistic: the row is being looked at, and a rename that lags behind
      // the keystroke reads as a failed edit. The session lives in exactly one
      // workspace bucket, so patch wherever it's found.
      const patch = (next: string | undefined) =>
        setSessionsByWorkspace((prev) => {
          const updated: Record<string, SessionInfo[]> = {};
          for (const [workspaceId, sessions] of Object.entries(prev)) {
            updated[workspaceId] = sessions.map((s) =>
              s.sessionId === session.sessionId ? { ...s, title: next } : s,
            );
          }
          return updated;
        });

      patch(title ?? undefined);
      try {
        await callGateway("session.set_title", { sessionId: session.sessionId, title });
      } catch (error) {
        console.error("Failed to rename session", error);
        patch(previous);
      }
    },
    [callGateway],
  );

  const onSetSessionDisposition = useCallback(
    async (session: SessionInfo, disposition: SessionDisposition) => {
      const previous = session.disposition;
      // Optimistic, like renaming: the menu item you just clicked should take
      // effect before the round trip. The server's `session.list_changed`
      // arrives moments later and is what actually removes the row when the
      // new disposition is a hidden one.
      const patch = (next: SessionDisposition | undefined) =>
        setSessionsByWorkspace((prev) => {
          const updated: Record<string, SessionInfo[]> = {};
          for (const [workspaceId, sessions] of Object.entries(prev)) {
            updated[workspaceId] = sessions.map((s) =>
              s.sessionId === session.sessionId ? { ...s, disposition: next } : s,
            );
          }
          return updated;
        });

      patch(disposition);
      try {
        await callGateway("session.set_status", { sessionId: session.sessionId, disposition });
      } catch (error) {
        console.error("Failed to set session status", error);
        patch(previous);
      }
    },
    [callGateway],
  );

  const onSearchSessions = useCallback(
    async (query: string): Promise<SessionSearchResult> => {
      const result = (await callGateway("session.search", {
        query,
        limit: 20,
      })) as Partial<SessionSearchResult> | null;
      return { hits: result?.hits ?? [], relaxed: result?.relaxed ?? false };
    },
    [callGateway],
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
        navigate(`/chat/${newWorkspace.id}/${sessionIdToUse}`);

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
  // workspace via `/chat/<id>/latest` lands on the same one.
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      setLatestSessionId(activeWorkspace.id, activeSessionId);
    }
  }, [activeSessionId, activeWorkspace]);

  // ── URL redirects (single writer) ────────────────────────────
  // Resolve `/chat`, `/chat/<id>`, and `/chat/<id>/latest` to a concrete
  // URL. Uses `replace: true` so the placeholder doesn't pollute the
  // back-button history.
  useEffect(() => {
    if (workspaces.length === 0) return;

    // No workspace in the URL → land on the first one's latest session.
    if (!workspaceId) {
      const first = workspaces[0];
      if (first) navigate(`/chat/${first.id}/latest`, { replace: true });
      return;
    }

    // Workspace in URL but no session → resolve to latest.
    if (workspaceId && !sessionId) {
      navigate(`/chat/${workspaceId}/latest`, { replace: true });
      return;
    }

    // `latest` sentinel → resolve once we know what "latest" means.
    if (sessionId === "latest") {
      const remembered = getLatestSessionId(workspaceId);
      const fallback = activeWorkspaceSessions[0]?.sessionId;
      const resolved = remembered ?? fallback;
      if (resolved) {
        navigate(`/chat/${workspaceId}/${resolved}`, { replace: true });
      }
      // If nothing's loaded yet we just leave `latest` in the URL — the
      // bootstrap fetch will populate `activeWorkspaceSessions` and this
      // effect will re-run.
    }
  }, [workspaceId, sessionId, workspaces, activeWorkspaceSessions]);

  // Refreshed after every commit rather than during render — a ref written
  // while rendering is torn by concurrent rendering, and this one is read from
  // a WebSocket callback that can fire at any moment.
  //
  // The refetch asks for at least as many rows as are currently shown, so a
  // list someone expanded with "Show more" doesn't silently collapse to five.
  useEffect(() => {
    workspacesRef.current = workspaces;
    sessionCountRef.current = Object.fromEntries(
      Object.entries(sessionsByWorkspace).map(([id, list]) => [id, list.length]),
    );
    refetchWorkspaceRef.current = (workspaceId: string) => {
      const ws = workspacesRef.current.find((w) => w.id === workspaceId);
      if (!ws) return;
      void loadSessionsForWorkspace(callGateway, ws.cwd, {
        limit: Math.max(SESSIONS_PAGE_SIZE, sessionCountRef.current[ws.id] ?? 0),
        offset: 0,
      })
        .then((result) => setSessionsForWorkspace(ws.id, result.sessions, result.hasMore))
        .catch(() => undefined);
    };
  });

  // ── Live session list ────────────────────────────────────────
  // Until now every tab held its own snapshot of the session list, taken
  // when it loaded — so two tabs disagreed within seconds and a session that
  // went quiet stayed looking busy forever. Two server events fix that, and
  // they're handled differently on purpose:
  //
  //   `session.status_changed` patches the one row in place — in place being
  //     the operative part, since a patch must never move a row. It's the high
  //     frequency event, and refetching a whole workspace because a dot went
  //     from grey to green would be absurd.
  //
  //   `session.list_changed` refetches the affected workspace's first page.
  //     Membership changed, and working out where a new row sorts would mean
  //     reimplementing the server's ordering rules in the client.
  //
  //   `session.activity` is the same patch as the first, applied on a
  //     heartbeat rather than an edge — so a tree row that missed a transition
  //     self-corrects within a second instead of at the next navigation. It
  //     also carries the name, which is how a session titled from its opening
  //     prompt stops reading as eight hex digits the moment you send it.
  //
  // A status event for a session this tab isn't showing is dropped rather
  // than triggering a fetch: it's usually another workspace's traffic, and
  // that workspace's own list event will arrive if membership actually moved.
  useEffect(() => {
    if (!client || !isConnected) return;

    const events = ["session.status_changed", "session.list_changed", "session.activity"];
    void client.subscribe(events).catch(() => {
      // Non-fatal: the list falls back to the snapshot behaviour it had
      // before, refreshed on navigation.
    });

    const patchRow = (payload: SessionRowPatch | undefined) => {
      if (!payload?.sessionId) return;
      setSessionsByWorkspace((prev) => {
        // Find the row wherever it is — the payload's workspaceId is
        // authoritative, but a session that moved workspaces would otherwise
        // leave a stale copy behind under the old key.
        let touched = false;
        const next: Record<string, SessionInfo[]> = {};
        for (const [wsId, sessions] of Object.entries(prev)) {
          const index = sessions.findIndex((s) => s.sessionId === payload.sessionId);
          if (index === -1) {
            next[wsId] = sessions;
            continue;
          }
          const current = sessions[index];
          if (!current) {
            next[wsId] = sessions;
            continue;
          }
          const title = payload.title ?? undefined;
          const firstPrompt = payload.firstPrompt ?? current.firstPrompt;
          if (
            current.runtimeStatus === payload.runtimeStatus &&
            current.disposition === payload.disposition &&
            current.title === title &&
            current.firstPrompt === firstPrompt
          ) {
            next[wsId] = sessions;
            continue;
          }
          const updated = [...sessions];
          // Patched in place: a live update changes what a row *says*, never
          // where it sits.
          //
          // This used to bump `modified` from the event and re-sort, on the
          // theory that a status change is activity and the row's recency
          // moved with it. That was tolerable when only transitions arrived
          // and untenable once the activity heartbeat did — a working session
          // re-sorted the whole tree about once a second, so rows crawled
          // upward under the cursor while you were reading them. The premise
          // was wrong either way: a list that reorders itself while you look
          // at it is not showing you recency, it's moving the thing you were
          // about to click. Order belongs to the server and changes on a
          // refetch, which is the only moment the list is allowed to move.
          updated[index] = {
            ...current,
            runtimeStatus: payload.runtimeStatus,
            disposition: payload.disposition,
            title,
            firstPrompt,
          };
          next[wsId] = updated;
          touched = true;
        }
        // Returning `prev` unchanged keeps React from re-rendering the whole
        // nav for an event about a session no tab is showing.
        return touched ? next : prev;
      });
    };

    const offStatus = client.on("session.status_changed", (_event, raw) =>
      patchRow(raw as SessionStatusChangedEvent | undefined),
    );
    const offActivity = client.on("session.activity", (_event, raw) =>
      patchRow(raw as SessionActivityEvent | undefined),
    );

    const offList = client.on("session.list_changed", (_event, raw) => {
      const payload = raw as SessionListChangedEvent | undefined;
      if (payload?.workspaceId) refetchWorkspaceRef.current(payload.workspaceId);
    });

    return () => {
      offStatus();
      offActivity();
      offList();
      void client.unsubscribe(events).catch(() => undefined);
    };
  }, [client, isConnected]);

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
      onRenameSession,
      onSetSessionDisposition,
      onSearchSessions,
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
      onRenameSession,
      onSetSessionDisposition,
      onSearchSessions,
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

  // Hoist WorkspaceProvider here so every panel in the chat layout — not just
  // chat.main — gets the active workspace's cwd. The editor panel uses it to
  // template `?folder=<cwd>` for code-server; future panels (terminal, file
  // tree, log viewer) will lean on the same hook.
  //
  // ClaudiaChat keeps its own nested WorkspaceProvider so embedded clients
  // (VS Code extension, menubar, iOS) that mount it directly still work.
  return (
    <ChatPageContext.Provider value={value}>
      <WorkspaceProvider cwd={activeWorkspace?.cwd}>{children}</WorkspaceProvider>
    </ChatPageContext.Provider>
  );
}
