import type { SessionTask } from "./task-workflow";
import { toSessionTaskFromStored } from "./task-workflow";
import type { StoredSession } from "../session-store";

interface RequestContextLike {
  connectionId: string | null;
  tags: string[] | null;
  responseText: string;
}

interface EventBridgeContext {
  emit: (
    eventName: string,
    payload: Record<string, unknown>,
    options?: { source?: string; connectionId?: string; tags?: string[] },
  ) => void;
}

interface TaskEventBridgeDeps {
  tasks: Map<string, SessionTask>;
  taskNotificationsSent: Set<string>;
  requestContexts: Map<string, RequestContextLike>;
  getCtx: () => EventBridgeContext | undefined;
  getStoredSession: (id: string) => StoredSession | null;
  upsertSession: (params: {
    id: string;
    workspaceId: string;
    providerSessionId: string;
    model: string;
    agent: string;
    purpose: "chat" | "task" | "review" | "test";
    parentSessionId?: string | null;
    runtimeStatus: "idle" | "running" | "completed" | "failed" | "interrupted" | "stalled";
    metadata?: Record<string, unknown> | null;
  }) => void;
  sessionConfig: { model: string };
  sendPrompt: (
    sessionId: string,
    content: string,
    cwd: string | undefined,
    model: string,
    agent: string,
  ) => Promise<void>;
  onTaskEvent: (
    listener: (event: { taskId: string; eventName: string; [key: string]: unknown }) => void,
  ) => void;
  removeTaskEventListener: (
    listener: (event: { taskId: string; eventName: string; [key: string]: unknown }) => void,
  ) => void;
  sid: (sessionId: string) => string;
  log: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
}

export interface TaskEventBridge {
  sendSessionNotification: (
    sessionId: string,
    text: string,
    options?: { connectionId?: string | null; tags?: string[] | null },
  ) => Promise<void>;
  notifyTaskCompletion: (task: SessionTask) => Promise<void>;
  wire: () => () => void;
}

export function createTaskEventBridge(deps: TaskEventBridgeDeps): TaskEventBridge {
  async function sendSessionNotification(
    sessionId: string,
    text: string,
    options?: { connectionId?: string | null; tags?: string[] | null },
  ): Promise<void> {
    const notifCtx: RequestContextLike = {
      connectionId: options?.connectionId ?? null,
      tags: options?.tags ?? null,
      responseText: "",
    };
    deps.requestContexts.set(sessionId, notifCtx);

    const wrapped = `<user_notification>\n${text}\n</user_notification>`;
    const stored = deps.getStoredSession(sessionId);
    await deps.sendPrompt(
      sessionId,
      wrapped,
      undefined,
      stored?.model || deps.sessionConfig.model,
      stored?.agent || "claude",
    );
  }

  async function notifyTaskCompletion(task: SessionTask): Promise<void> {
    if (task.status === "running") return;
    if (deps.taskNotificationsSent.has(task.taskId)) return;
    deps.taskNotificationsSent.add(task.taskId);

    const elapsedSecs = Math.max(
      0,
      Math.round((Date.parse(task.updatedAt) - Date.parse(task.startedAt)) / 1000),
    );
    const agentLabel =
      task.agent.length > 0 ? `${task.agent[0].toUpperCase()}${task.agent.slice(1)}` : "Agent";

    let content: string;
    if (task.status === "completed") {
      content =
        `${agentLabel} completed ${task.mode} task ${task.taskId} (${elapsedSecs}s).` +
        `${task.outputFile ? ` Output: ${task.outputFile}` : ""}`;
    } else if (task.status === "interrupted") {
      content =
        `${agentLabel} ${task.mode} task ${task.taskId} was interrupted (${elapsedSecs}s).` +
        `${task.outputFile ? ` Partial output: ${task.outputFile}` : ""}`;
    } else {
      content =
        `${agentLabel} failed ${task.mode} task ${task.taskId} (${elapsedSecs}s): ${task.error || "unknown error"}.` +
        `${task.outputFile ? ` Partial output: ${task.outputFile}` : ""}`;
    }

    try {
      await sendSessionNotification(task.sessionId, content, task.context);
      deps.log.info("Sent task completion notification", {
        taskId: task.taskId,
        sessionId: deps.sid(task.sessionId),
        status: task.status,
      });
    } catch (error) {
      deps.log.warn("Failed task completion notification", {
        taskId: task.taskId,
        sessionId: deps.sid(task.sessionId),
        status: task.status,
        error: String(error),
      });
    }
  }

  function wire(): () => void {
    const listener = (event: { taskId: string; eventName: string; [key: string]: unknown }) => {
      const ctx = deps.getCtx();
      if (!ctx) return;

      const taskId = event.taskId;
      let task: SessionTask | null | undefined = deps.tasks.get(taskId);
      if (!task) {
        task = toSessionTaskFromStored(deps.getStoredSession(taskId));
        if (task) deps.tasks.set(taskId, task);
      }
      if (!task) return;

      const hostEventType = String(event.type || "");
      const payload = { ...event } as Record<string, unknown>;
      delete payload.taskId;
      delete payload.eventName;

      if (hostEventType === "stop") {
        task.status = payload.status === "interrupted" ? "interrupted" : "completed";
      } else if (hostEventType === "error") {
        task.status = "failed";
        task.error = String(payload.error || "Task failed");
      }
      if (typeof payload.outputFile === "string") task.outputFile = payload.outputFile;
      if (typeof payload.cwd === "string") task.cwd = payload.cwd;
      if (typeof payload.worktreePath === "string") task.worktreePath = payload.worktreePath;
      if (typeof payload.parentRepoPath === "string") task.parentRepoPath = payload.parentRepoPath;
      if (typeof payload.continuedFromTaskId === "string") {
        task.continuedFromTaskId = payload.continuedFromTaskId;
      }
      if (payload.git && typeof payload.git === "object" && !Array.isArray(payload.git)) {
        task.git = payload.git as Record<string, unknown>;
      }
      task.updatedAt = new Date().toISOString();

      const taskStored = deps.getStoredSession(task.taskId);
      const parentStored = deps.getStoredSession(task.sessionId);
      const workspaceId = taskStored?.workspaceId || parentStored?.workspaceId;
      if (workspaceId) {
        deps.upsertSession({
          id: task.taskId,
          workspaceId,
          providerSessionId: task.taskId,
          model: taskStored?.model || parentStored?.model || deps.sessionConfig.model,
          agent: task.agent,
          purpose: task.mode === "review" || task.mode === "test" ? task.mode : "task",
          parentSessionId: task.sessionId,
          runtimeStatus: task.status === "running" ? "running" : task.status,
          metadata: {
            prompt: task.prompt,
            cwd: task.cwd,
            worktreePath: task.worktreePath,
            parentRepoPath: task.parentRepoPath,
            continuedFromTaskId: task.continuedFromTaskId,
            git: task.git,
            outputFile: task.outputFile,
            error: task.error,
            connectionId: task.context.connectionId,
            tags: task.context.tags,
          },
        });
      }

      const mappedType =
        hostEventType === "start" ||
        hostEventType === "delta" ||
        hostEventType === "item" ||
        hostEventType === "stop" ||
        hostEventType === "error"
          ? hostEventType
          : "item";

      const emitOptions: { source?: string; connectionId?: string; tags?: string[] } = {
        source: "gateway.caller",
      };
      if (task.context.connectionId) emitOptions.connectionId = task.context.connectionId;
      if (task.context.tags) emitOptions.tags = task.context.tags;

      ctx.emit(
        `session.task.${taskId}.${mappedType}`,
        {
          taskId,
          sessionId: task.sessionId,
          agent: task.agent,
          status: task.status,
          hostEventType,
          payload,
        },
        emitOptions,
      );

      if ((hostEventType === "stop" || hostEventType === "error") && task.status !== "running") {
        void notifyTaskCompletion(task);
      }
    };

    deps.onTaskEvent(listener);
    return () => deps.removeTaskEventListener(listener);
  }

  return {
    sendSessionNotification,
    notifyTaskCompletion,
    wire,
  };
}
