import { useState, useEffect, useRef, useCallback } from "react";
import { ClaudiaChat, NavigationDrawer, navigate, useGatewayClient } from "@claudia/ui";
import type { WorkspaceInfo, SessionInfo } from "@claudia/ui";
import { bridge, GATEWAY_URL } from "../app";
import {
  createSessionForWorkspace,
  loadMainPageBootstrapData,
  loadSessionsForWorkspace,
} from "./helpers/main-page-gateway";

export function MainPage({ workspaceId, sessionId }: { workspaceId?: string; sessionId?: string }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const { call, isConnected } = useGatewayClient(GATEWAY_URL);
  const activeWorkspaceRef = useRef<WorkspaceInfo | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

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
        if (!activeWorkspaceRef.current) return;
        return loadSessionsForWorkspace(callGateway, activeWorkspaceRef.current.cwd).then(
          (sessionsPayload) => {
            setSessions(sessionsPayload);
          },
        );
      })
      .catch(() => undefined);
  }, [callGateway]);

  // Update URL when new session is created
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      navigate(`/workspace/${activeWorkspace.id}/session/${activeSessionId}`);
    }
  }, [activeSessionId, activeWorkspace]);

  // Watch for prop changes (when router updates URL without re-mounting)
  useEffect(() => {
    // If sessionId prop changes and differs from current state, update state
    if (sessionId && sessionId !== activeSessionId) {
      setActiveSessionId(sessionId);
    }
  }, [sessionId, activeSessionId]);

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
    // TODO: show create workspace modal
  }, []);

  return (
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
            bridge={bridge}
            gatewayOptions={{ sessionId: activeSessionId, workspaceId: activeWorkspace.id }}
            key={`${activeWorkspace.id}-${activeSessionId}`}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400">
            {activeWorkspace
              ? "Select a session or create a new one"
              : "Select a workspace to get started"}
          </div>
        )}
      </div>
    </div>
  );
}
