import { touchSession } from "../session-store";
import { type RequestContext, mergeTags, toRuntimeStatusFromSessionEvent } from "../session-types";

type SessionEvent = { eventName: string; sessionId: string; [key: string]: unknown };
type SessionEventListener = (event: SessionEvent) => void;

interface SessionEventBridgeDeps {
  requestContexts: Map<string, RequestContext>;
  primaryContexts: Map<string, RequestContext>;
  getCtx: () =>
    | {
        emit: (
          eventName: string,
          payload: Record<string, unknown>,
          options?: { source?: string; connectionId?: string; tags?: string[] },
        ) => void;
      }
    | undefined;
  agentClient: {
    on(event: "session.event", listener: SessionEventListener): void;
    removeListener(event: "session.event", listener: SessionEventListener): void;
  };
}

export interface SessionEventBridge {
  wire: () => () => void;
}

export function createSessionEventBridge(deps: SessionEventBridgeDeps): SessionEventBridge {
  return {
    wire: () => {
      const listener: SessionEventListener = (event) => {
        const ctx = deps.getCtx();
        if (!ctx) return;

        const { eventName, sessionId, ...payload } = event;
        const reqCtx = deps.requestContexts.get(sessionId);
        const primaryCtx = deps.primaryContexts.get(sessionId);

        const emitOptions: { source?: string; connectionId?: string; tags?: string[] } = {};
        if (reqCtx?.source) emitOptions.source = reqCtx.source;
        const connId = primaryCtx?.connectionId ?? reqCtx?.connectionId;
        if (connId) emitOptions.connectionId = connId;
        const mergedTags_ = mergeTags(primaryCtx?.tags ?? null, reqCtx?.tags ?? null);
        if (mergedTags_) emitOptions.tags = mergedTags_;

        ctx.emit(
          eventName,
          { ...payload, sessionId },
          Object.keys(emitOptions).length > 0 ? emitOptions : undefined,
        );

        const runtimeStatus =
          typeof payload.type === "string" ? toRuntimeStatusFromSessionEvent(payload.type) : null;
        if (runtimeStatus) {
          touchSession(sessionId, runtimeStatus);
        } else {
          touchSession(sessionId);
        }

        if (payload.type === "content_block_delta") {
          const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
          if (delta?.type === "text_delta" && delta.text && reqCtx) {
            reqCtx.responseText += delta.text;
          }
        }
      };

      deps.agentClient.on("session.event", listener);
      return () => deps.agentClient.removeListener("session.event", listener);
    },
  };
}
