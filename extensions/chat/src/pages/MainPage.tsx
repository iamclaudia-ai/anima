import { useState, useEffect, useRef, useCallback } from "react";
import { ClaudiaChat, NavigationDrawer, navigate } from "@claudia/ui";
import type { WorkspaceInfo, SessionInfo, GatewayMessage } from "@claudia/ui";
import { bridge, GATEWAY_URL } from "../app";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function MainPage({ workspaceId, sessionId }: { workspaceId?: string; sessionId?: string }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, string>>(new Map());
  const activeWorkspaceRef = useRef<WorkspaceInfo | null>(null);

  const sendRequest = useCallback((method: string, params?: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const id = generateId();
    const msg: GatewayMessage = { type: "req", id, method, params };
    pendingRef.current.set(id, method);
    wsRef.current.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(GATEWAY_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      sendRequest("session.list_workspaces");
    };

    ws.onclose = () => setIsConnected(false);

    ws.onmessage = (event) => {
      const data: GatewayMessage = JSON.parse(event.data);

      if (data.type === "res" && data.ok && data.payload) {
        const payload = data.payload as Record<string, unknown>;
        const method = data.id ? pendingRef.current.get(data.id) : undefined;
        if (data.id) pendingRef.current.delete(data.id);

        if (method === "session.list_workspaces") {
          const list = payload.workspaces as WorkspaceInfo[] | undefined;
          setWorkspaces(list || []);

          // Auto-select workspace from URL params or first workspace
          if (!activeWorkspaceRef.current && list && list.length > 0) {
            const targetWorkspace = workspaceId
              ? list.find((ws) => ws.id === workspaceId)
              : list[0];

            if (targetWorkspace) {
              setActiveWorkspace(targetWorkspace);
              activeWorkspaceRef.current = targetWorkspace;
              sendRequest("session.list_sessions", { cwd: targetWorkspace.cwd });
            }
          }
        }

        if (method === "session.list_sessions") {
          const list = payload.sessions as SessionInfo[] | undefined;
          setSessions(list || []);

          // Auto-select session from URL params if provided
          if (sessionId && !activeSessionId && list && list.length > 0) {
            const targetSession = list.find((s) => s.sessionId === sessionId);
            if (targetSession) {
              setActiveSessionId(targetSession.sessionId);
            }
          }
        }

        if (method === "session.create_session") {
          const sessionId = payload.sessionId as string | undefined;
          if (sessionId) {
            setActiveSessionId(sessionId);
            // Refresh sessions list
            if (activeWorkspaceRef.current) {
              sendRequest("session.list_sessions", { cwd: activeWorkspaceRef.current.cwd });
            }
          }
        }

        if (method === "session.get_or_create_workspace") {
          // Refresh workspaces
          sendRequest("session.list_workspaces");
        }
      }
    };

    return () => {
      ws.close();
    };
  }, [GATEWAY_URL, sendRequest]);

  const handleWorkspaceSelect = useCallback(
    (workspace: WorkspaceInfo) => {
      setActiveWorkspace(workspace);
      activeWorkspaceRef.current = workspace;
      setActiveSessionId(null);
      setSessions([]);
      sendRequest("session.list_sessions", { cwd: workspace.cwd });
    },
    [sendRequest],
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
    sendRequest("session.create_session", { cwd: activeWorkspaceRef.current.cwd });
  }, [sendRequest]);

  // Update URL when new session is created
  useEffect(() => {
    if (activeSessionId && activeWorkspace) {
      navigate(`/workspace/${activeWorkspace.id}/session/${activeSessionId}`);
    }
  }, [activeSessionId, activeWorkspace]);

  const handleNewWorkspace = useCallback(() => {
    // TODO: show create workspace modal
  }, []);

  return (
    <div className="flex h-screen">
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
      <div className="flex-1 bg-white">
        {activeSessionId && activeWorkspace ? (
          <ClaudiaChat
            bridge={bridge}
            gatewayOptions={{ sessionId: activeSessionId, workspaceId: activeWorkspace.id }}
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
