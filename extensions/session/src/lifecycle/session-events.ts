interface RequestContextLike {
  connectionId: string | null;
  tags: string[] | null;
  source?: string;
  responseText: string;
}

interface SessionEventBridgeDeps {
  requestContexts: Map<string, RequestContextLike>;
  primaryContexts: Map<string, RequestContextLike>;
  getCtx: () =>
    | {
        emit: (
          eventName: string,
          payload: Record<string, unknown>,
          options?: { source?: string; connectionId?: string; tags?: string[] },
        ) => void;
      }
    | undefined;
  mergeTags: (primary: string[] | null, current: string[] | null) => string[] | null;
  toRuntimeStatusFromSessionEvent: (
    type: string,
  ) => "idle" | "running" | "completed" | "failed" | "interrupted" | "stalled" | null;
  touchSession: (
    sessionId: string,
    runtimeStatus?: "idle" | "running" | "completed" | "failed" | "interrupted" | "stalled",
  ) => void;
  onSessionEvent: (
    listener: (event: { eventName: string; sessionId: string; [key: string]: unknown }) => void,
  ) => void;
  removeSessionEventListener: (
    listener: (event: { eventName: string; sessionId: string; [key: string]: unknown }) => void,
  ) => void;
}

export interface SessionEventBridge {
  wire: () => () => void;
}

export function createSessionEventBridge(deps: SessionEventBridgeDeps): SessionEventBridge {
  return {
    wire: () => {
      const listener = (event: {
        eventName: string;
        sessionId: string;
        [key: string]: unknown;
      }) => {
        const ctx = deps.getCtx();
        if (!ctx) return;

        const { eventName, sessionId, ...payload } = event;
        const reqCtx = deps.requestContexts.get(sessionId);
        const primaryCtx = deps.primaryContexts.get(sessionId);

        const emitOptions: { source?: string; connectionId?: string; tags?: string[] } = {};
        if (reqCtx?.source) emitOptions.source = reqCtx.source;
        const connId = primaryCtx?.connectionId ?? reqCtx?.connectionId;
        if (connId) emitOptions.connectionId = connId;
        const mergedTags = deps.mergeTags(primaryCtx?.tags ?? null, reqCtx?.tags ?? null);
        if (mergedTags) emitOptions.tags = mergedTags;

        ctx.emit(
          eventName,
          { ...payload, sessionId },
          Object.keys(emitOptions).length > 0 ? emitOptions : undefined,
        );

        const runtimeStatus =
          typeof payload.type === "string"
            ? deps.toRuntimeStatusFromSessionEvent(payload.type)
            : null;
        if (runtimeStatus) {
          deps.touchSession(sessionId, runtimeStatus);
        } else {
          deps.touchSession(sessionId);
        }

        if (payload.type === "content_block_delta") {
          const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
          if (delta?.type === "text_delta" && delta.text && reqCtx) {
            reqCtx.responseText += delta.text;
          }
        }
      };

      deps.onSessionEvent(listener);
      return () => deps.removeSessionEventListener(listener);
    },
  };
}
