import { getStoredSession, touchSession, updateSessionMetadata } from "../session-store";
import { applyRuntimeStatus, emitActivity, forgetActivity } from "../session-status-events";
import { toRuntimeStatusFromModalEvent, toRuntimeStatusFromSessionEvent } from "../session-types";
import { getRuntime } from "../runtime";
import { getWorkspace } from "../workspace";
import { collectGitStatus } from "../git-status";
import { cancelPendingGitStatus, noteToolResult, noteToolUseStart } from "./git-status-debouncer";
import { createLogger, shortId, truncatePreservingSurrogates } from "@anima/shared";
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
    //
    // Metadata only — deliberately not a status write. This runs after
    // `turn_stop`, asynchronously, and shells out to `gh`, so it can land
    // seconds later. It used to assert `completed` on the way past, which
    // meant a turn started in that gap had its `running` silently overwritten
    // with no event to correct it: the row read "done" while the agent was
    // mid-sentence. Whatever the status is by the time this returns, this is
    // not the code that knows it.
    updateSessionMetadata(sessionId, {
      gitStatus: { ...finalStatus, capturedAt: new Date().toISOString() },
    });
    const rt = getRuntime();
    const emitOptions = rt.sessionActors.getRoutingOptions(sessionId);
    rt.ctx.emit(`session.${sessionId}.git_status`, { sessionId, ...finalStatus }, emitOptions);
  } catch (err) {
    log.error("emitGitStatus failed", {
      sessionId: shortId(sessionId),
      error: err instanceof Error ? err.message : String(err),
      stack:
        err instanceof Error && err.stack
          ? truncatePreservingSurrogates(err.stack, 800)
          : undefined,
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
      // Writes and announces in one step, and only when the status actually
      // moved — this runs per streamed event, so an unconditional emit would
      // put a bus message behind every token.
      applyRuntimeStatus(sessionId, runtimeStatus);
    } else {
      touchSession(sessionId);
      // Every streamed event re-asserts that this session is alive, throttled
      // to roughly once a second. The transition event alone is an edge, and
      // an edge is only ever as reliable as the delivery of one message; a tab
      // that missed it sat on a stale row until the next poll. See
      // `emitActivity` for why this is a separate event from `status_changed`.
      emitActivity(sessionId);
    }

    if (payload.type === "content_block_delta") {
      const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
      if (delta?.type === "text_delta" && delta.text) {
        rt.sessionActors.appendResponseText(sessionId, delta.text);
      }
    } else if (payload.type === "content_block_start") {
      const block = (payload as { content_block?: { type?: string; id?: string; name?: string } })
        .content_block;
      if (block?.type === "tool_use" && block.id && block.name) {
        noteToolUseStart(sessionId, block.id, block.name);
      }
    } else if (payload.type === "request_tool_results") {
      const results = (payload as { tool_results?: Array<{ tool_use_id?: string }> }).tool_results;
      if (results) {
        for (const r of results) {
          if (r.tool_use_id) noteToolResult(sessionId, r.tool_use_id);
        }
      }
    } else if (payload.type === "turn_stop") {
      cancelPendingGitStatus(sessionId);
      forgetActivity(sessionId);
      // The counterpart to agent-host's `message_stop` line. Between them they
      // say whether a turn that ended upstream actually landed as `completed`
      // here — the two halves of a spinner that never stops.
      log.info("turn_stop received", {
        sessionId: shortId(sessionId),
        stopReason: (payload as { stop_reason?: string }).stop_reason ?? "unknown",
      });
      applyRuntimeStatus(sessionId, "completed", {
        metadataPatch: { lastAssistantMessageAt: new Date().toISOString() },
      });
      rt.sessionActors.completeTurn(
        sessionId,
        (payload as { stop_reason?: string }).stop_reason || "unknown",
      );
      void emitGitStatus(sessionId);
    } else if (payload.type === "modal_prompt" || payload.type === "modal_prompt_cleared") {
      // A blocked session needs its own clock. `lastAssistantMessageAt` — what
      // "waiting 20 minutes" normally counts from — is written by `turn_stop`,
      // so for a session blocked mid-turn it still holds the *previous* turn's
      // end and would report a wait that started before the prompt existed.
      const status = toRuntimeStatusFromModalEvent(payload.type, payload);
      if (status) {
        applyRuntimeStatus(sessionId, status, {
          metadataPatch: {
            blockedSince: payload.type === "modal_prompt" ? new Date().toISOString() : null,
          },
        });
      }
    } else if (payload.type === "process_died") {
      // A died process is exactly the "silently abandoned" case the nav is
      // meant to surface — it never reaches turn_stop, so without this the row
      // sits on `running` forever.
      applyRuntimeStatus(sessionId, "failed");
      rt.sessionActors.failTurn(
        sessionId,
        new Error(`Session process died: ${(payload as { reason?: string }).reason || "unknown"}`),
      );
    }
  };

  rt.bridge.onSessionEvent(listener);
  return () => rt.bridge.offSessionEvent(listener);
}
