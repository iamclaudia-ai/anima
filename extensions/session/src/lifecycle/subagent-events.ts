import { createLogger, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionSubagent } from "./subagent-workflow";
import { toSessionSubagentFromStored } from "./subagent-workflow";
import type { RequestContext } from "../session-types";
import { getRuntime } from "../runtime";

const log = createLogger(
  "SessionExt:SubagentEvents",
  join(homedir(), ".anima", "logs", "session.log"),
);

type SessionEvent = { sessionId: string; eventName: string; [key: string]: unknown };

/** Send a notification prompt to an existing session. */
export async function sendSessionNotification(
  sessionId: string,
  text: string,
  options?: { connectionId?: string | null; tags?: string[] | null },
): Promise<void> {
  const rt = getRuntime();
  const notifCtx: RequestContext = {
    connectionId: options?.connectionId ?? null,
    tags: options?.tags ?? null,
    responseText: "",
  };
  rt.sessionActors.bindNotificationRequest(sessionId, notifCtx);

  const wrapped = `<user_notification>\n${text}\n</user_notification>`;
  const stored = rt.registry.getStoredSession(sessionId);
  await rt.bridge.prompt(
    sessionId,
    wrapped,
    undefined,
    stored?.model || rt.sessionConfig.model,
    stored?.agent || "claude",
  );
}

/** Notify the parent session that a subagent has completed. */
export async function notifySubagentCompletion(subagent: SessionSubagent): Promise<void> {
  const rt = getRuntime();
  if (subagent.status === "running") return;
  if (rt.subagentNotificationsSent.has(subagent.subagentId)) return;
  rt.subagentNotificationsSent.add(subagent.subagentId);

  const elapsedSecs = Math.max(
    0,
    Math.round((Date.parse(subagent.updatedAt) - Date.parse(subagent.startedAt)) / 1000),
  );
  const agentLabel =
    subagent.agent.length > 0
      ? `${subagent.agent[0].toUpperCase()}${subagent.agent.slice(1)}`
      : "Agent";

  let content: string;
  if (subagent.status === "completed") {
    content = `${agentLabel} subagent ${subagent.subagentId} completed (${elapsedSecs}s).`;
  } else if (subagent.status === "interrupted") {
    content = `${agentLabel} subagent ${subagent.subagentId} was interrupted (${elapsedSecs}s).`;
  } else {
    content = `${agentLabel} subagent ${subagent.subagentId} failed (${elapsedSecs}s): ${
      subagent.error || "unknown error"
    }.`;
  }

  try {
    await sendSessionNotification(subagent.parentSessionId, content, subagent.context);
    log.info("Sent subagent completion notification", {
      subagentId: subagent.subagentId,
      parentSessionId: shortId(subagent.parentSessionId),
      status: subagent.status,
    });
  } catch (error) {
    log.warn("Failed subagent completion notification", {
      subagentId: subagent.subagentId,
      parentSessionId: shortId(subagent.parentSessionId),
      status: subagent.status,
      error: String(error),
    });
  }
}

/** Wire child-session completion tracking. Returns unsubscribe function. */
export function wireSubagentEvents(): () => void {
  const rt = getRuntime();

  const listener = (event: SessionEvent) => {
    const subagentId = event.sessionId;
    let subagent: SessionSubagent | null | undefined = rt.subagents.get(subagentId);
    if (!subagent) {
      subagent = toSessionSubagentFromStored(rt.registry.getStoredSession(subagentId));
      if (subagent) rt.subagents.set(subagentId, subagent);
    }
    if (!subagent) return;

    const eventType = String(event.type || "");
    if (eventType === "turn_stop") {
      subagent.status = event.stop_reason === "abort" ? "interrupted" : "completed";
    } else if (eventType === "process_died") {
      subagent.status = "failed";
      subagent.error = String(event.reason || "Subagent runtime failed");
    } else {
      return;
    }

    subagent.updatedAt = new Date().toISOString();
    const stored = rt.registry.getStoredSession(subagentId);
    if (stored) {
      rt.registry.upsertSession({
        id: stored.id,
        workspaceId: stored.workspaceId,
        providerSessionId: stored.providerSessionId,
        model: stored.model,
        agent: stored.agent,
        purpose: stored.purpose,
        parentSessionId: stored.parentSessionId,
        runtimeStatus: subagent.status,
        status: stored.status,
        title: stored.title,
        summary: stored.summary,
        metadata: { ...(stored.metadata || {}), error: subagent.error },
        previousSessionId: stored.previousSessionId,
      });
    }

    void notifySubagentCompletion(subagent);
  };

  rt.bridge.onSessionEvent(listener);
  return () => rt.bridge.offSessionEvent(listener);
}
