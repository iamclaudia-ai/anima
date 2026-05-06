import { getStoredSession, touchSession, updateSessionRuntime } from "../session-store";
import { toRuntimeStatusFromSessionEvent } from "../session-types";
import { getRuntime } from "../runtime";
import { getWorkspace } from "../workspace";
import { collectGitStatus } from "../git-status";
import { createLogger, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("SessionExt:GitStatus", join(homedir(), ".anima", "logs", "session.log"));

export async function emitGitStatus(sessionId: string): Promise<void> {
  try {
    log.info("emitGitStatus start", { sessionId: shortId(sessionId) });
    const stored = getStoredSession(sessionId);
    if (!stored) {
      log.warn("emitGitStatus: no stored session", { sessionId: shortId(sessionId) });
      return;
    }
    const workspace = getWorkspace(stored.workspaceId);
    if (!workspace?.cwd) {
      log.warn("emitGitStatus: no workspace cwd", {
        sessionId: shortId(sessionId),
        workspaceId: stored.workspaceId,
      });
      return;
    }
    log.info("emitGitStatus collecting", { cwd: workspace.cwd });
    const status = await collectGitStatus(workspace.cwd);
    log.info("emitGitStatus collected", {
      cwd: workspace.cwd,
      branch: status.branch,
      pr: status.pr ? `#${status.pr.number}` : status.pr === undefined ? "unknown" : "none",
    });
    // If the PR lookup failed (undefined), preserve any previously-cached PR
    // so a transient `gh` flake doesn't blow away a known PR link.
    const priorPr = (stored.metadata?.gitStatus as { pr?: unknown } | undefined)?.pr ?? null;
    const resolvedPr = status.pr === undefined ? priorPr : status.pr;
    const finalStatus = { ...status, pr: resolvedPr };
    // Persist to session metadata so it's available on get_history without a new turn.
    updateSessionRuntime(sessionId, "completed", {
      gitStatus: { ...finalStatus, capturedAt: new Date().toISOString() },
    });
    const rt = getRuntime();
    const emitOptions = rt.sessionActors.getRoutingOptions(sessionId);
    rt.ctx.emit(`session.${sessionId}.git_status`, { sessionId, ...finalStatus }, emitOptions);
  } catch (err) {
    log.error("emitGitStatus failed", {
      sessionId: shortId(sessionId),
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
    });
  }
}

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
      updateSessionRuntime(sessionId, "completed", {
        lastAssistantMessageAt: new Date().toISOString(),
      });
      rt.sessionActors.completeTurn(
        sessionId,
        (payload as { stop_reason?: string }).stop_reason || "unknown",
      );
      void emitGitStatus(sessionId);
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
