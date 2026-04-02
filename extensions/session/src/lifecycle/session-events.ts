import { touchSession } from "../session-store";
import { toRuntimeStatusFromSessionEvent } from "../session-types";
import { getRuntime } from "../runtime";

type SessionEvent = { eventName: string; sessionId: string; [key: string]: unknown };

/** Wire session event bridge. Returns unsubscribe function. */
export function wireSessionEvents(): () => void {
  const rt = getRuntime();

  const listener = (event: SessionEvent) => {
    const { eventName, sessionId, ...payload } = event;
    const emitOptions = rt.sessionActors.getRoutingOptions(sessionId);

    rt.ctx.emit(eventName, { ...payload, sessionId }, emitOptions);

    const runtimeStatus =
      typeof payload.type === "string" ? toRuntimeStatusFromSessionEvent(payload.type) : null;
    if (runtimeStatus) {
      touchSession(sessionId, runtimeStatus);
    } else {
      touchSession(sessionId);
    }

    if (payload.type === "content_block_delta") {
      const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
      if (delta?.type === "text_delta" && delta.text) {
        rt.sessionActors.appendResponseText(sessionId, delta.text);
      }
    } else if (payload.type === "turn_stop") {
      rt.sessionActors.completeTurn(
        sessionId,
        (payload as { stop_reason?: string }).stop_reason || "unknown",
      );
    } else if (payload.type === "process_died") {
      rt.sessionActors.failTurn(
        sessionId,
        new Error(`Session process died: ${(payload as { reason?: string }).reason || "unknown"}`),
      );
    }
  };

  rt.bridge.onSessionEvent(listener);
  return () => rt.bridge.offSessionEvent(listener);
}
