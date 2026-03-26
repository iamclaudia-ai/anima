import { touchSession } from "../session-store";
import { mergeTags, toRuntimeStatusFromSessionEvent } from "../session-types";
import { getRuntime } from "../runtime";

type SessionEvent = { eventName: string; sessionId: string; [key: string]: unknown };

/** Wire session event bridge. Returns unsubscribe function. */
export function wireSessionEvents(): () => void {
  const rt = getRuntime();

  const listener = (event: SessionEvent) => {
    const { eventName, sessionId, ...payload } = event;
    const reqCtx = rt.requestContexts.get(sessionId);
    const primaryCtx = rt.primaryContexts.get(sessionId);

    const emitOptions: { source?: string; connectionId?: string; tags?: string[] } = {};
    if (reqCtx?.source) emitOptions.source = reqCtx.source;
    const connId = primaryCtx?.connectionId ?? reqCtx?.connectionId;
    if (connId) emitOptions.connectionId = connId;
    const mergedTags_ = mergeTags(primaryCtx?.tags ?? null, reqCtx?.tags ?? null);
    if (mergedTags_) emitOptions.tags = mergedTags_;

    rt.ctx.emit(
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

  rt.agentClient.on("session.event", listener);
  return () => rt.agentClient.removeListener("session.event", listener);
}
