import { randomUUID } from "node:crypto";
import { rotatePersistentSessions } from "./persistent-sessions";
import {
  normalizeTaskMode,
  type SessionTask,
  type TaskStatus,
  type TaskWorkflowRunner,
} from "./lifecycle/task-workflow";
import type { RuntimeStatus, SessionPurpose, StoredSession } from "./session-store";

interface SessionConfigLike {
  model: string;
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  systemPrompt: string | null;
}

interface SessionDispatchDeps {
  config: Record<string, unknown>;
  sessionConfig: SessionConfigLike;
  log: {
    info: (message: string, data?: Record<string, unknown>) => void;
  };
  sid: (id: string) => string;
  getCtx: () => {
    connectionId: string | null;
    tags: string[] | null;
    store: {
      get: <T>(key: string) => T | undefined;
      set: (key: string, value: unknown) => void;
    };
  };
  getDirectories: (path: string) => string[];
  getStoredSession: (sessionId: string) => StoredSession | null;
  getWorkspace: (id: string) => unknown;
  getOrCreateWorkspace: (
    cwd: string,
    name?: string,
    general?: boolean,
  ) => { workspace: { id: string; general: boolean }; created: boolean };
  setWorkspaceActiveSession: (workspaceId: string, sessionId: string) => void;
  upsertSession: (params: {
    id: string;
    workspaceId: string;
    providerSessionId?: string;
    model?: string;
    agent?: string;
    purpose?: SessionPurpose;
    parentSessionId?: string | null;
    status?: "active" | "archived";
    runtimeStatus?: RuntimeStatus;
    title?: string | null;
    summary?: string | null;
    metadata?: Record<string, unknown> | null;
    previousSessionId?: string | null;
    lastActivity?: string;
  }) => void;
  requestState: {
    requestContexts: Map<string, unknown>;
    primaryContexts: Map<string, unknown>;
    tasks: Map<string, SessionTask>;
  };
  agent: {
    list: () => Promise<Array<{ id: string }>>;
    interrupt: (sessionId: string) => Promise<boolean>;
    close: (sessionId: string) => Promise<void>;
    setPermissionMode: (sessionId: string, mode: string) => Promise<boolean>;
    sendToolResult: (
      sessionId: string,
      toolUseId: string,
      content: string,
      isError?: boolean,
    ) => Promise<boolean>;
    getTask: (taskId: string) => Promise<{ task?: SessionTask | null }>;
  };
  promptLifecycle: {
    run: (
      input: {
        sessionId: string;
        content: string | unknown[];
        cwd?: string;
        model?: string;
        agent: string;
        streaming: boolean;
        source?: string;
      },
      envelope: { connectionId: string | null; tags: string[] | null },
    ) => Promise<unknown>;
  };
  sessionActivation: {
    switchSession: (params: { sessionId: string; cwd: string; model?: string }) => Promise<unknown>;
    resetSession: (params: { cwd: string; model?: string }) => Promise<unknown>;
  };
  taskWorkflow: TaskWorkflowRunner;
  taskEventBridge: {
    sendSessionNotification: (
      sessionId: string,
      text: string,
      envelope: { connectionId: string | null; tags: string[] | null },
    ) => Promise<void>;
  };
  sessionQuery: {
    listSessions: (cwd: string) => unknown;
    getHistory: (params: {
      sessionId: string;
      cwd?: string;
      limit?: number;
      offset?: number;
    }) => unknown;
    getMemoryContext: (cwd?: string) => Promise<unknown>;
  };
  listWorkspaces: () => unknown[];
  deleteWorkspace: (cwd: string) => boolean;
  healthCheckDetailed: () => Promise<unknown>;
}

export function createSessionMethodDispatcher(deps: SessionDispatchDeps) {
  return async function dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "session.create_session": {
        const cwd = params.cwd as string;
        const agent = (params.agent as string | undefined) || "claude";
        const model = (params.model as string | undefined) || deps.sessionConfig.model;
        const thinking = (params.thinking as boolean | undefined) ?? deps.sessionConfig.thinking;
        const effort =
          (params.effort as "low" | "medium" | "high" | "max" | undefined) ||
          deps.sessionConfig.effort;
        const systemPrompt =
          (params.systemPrompt as string | undefined) ||
          deps.sessionConfig.systemPrompt ||
          undefined;

        deps.log.info("Creating session", {
          agent,
          cwd,
          model,
          thinking,
          effort,
        });
        const workspaceResult = deps.getOrCreateWorkspace(cwd);
        const sessionId = randomUUID();
        deps.upsertSession({
          id: sessionId,
          workspaceId: workspaceResult.workspace.id,
          providerSessionId: sessionId,
          model,
          agent,
          purpose: "chat",
          runtimeStatus: "idle",
          metadata: {
            bootstrapSystemPrompt: systemPrompt,
            bootstrapThinking: thinking,
            bootstrapEffort: effort,
          },
        });
        deps.setWorkspaceActiveSession(workspaceResult.workspace.id, sessionId);
        deps.log.info("Session draft created", { sessionId: deps.sid(sessionId), cwd });
        return { sessionId };
      }

      case "session.send_prompt": {
        const ctx = deps.getCtx();
        return await deps.promptLifecycle.run(
          {
            sessionId: params.sessionId as string,
            content: params.content as string | unknown[],
            cwd: params.cwd as string | undefined,
            model: params.model as string | undefined,
            agent: (params.agent as string | undefined) || "claude",
            streaming: params.streaming !== false,
            source: params.source as string | undefined,
          },
          {
            connectionId: ctx.connectionId,
            tags: ctx.tags,
          },
        );
      }

      case "session.interrupt_session": {
        deps.log.info("Interrupting session", { sessionId: deps.sid(params.sessionId as string) });
        const ok = await deps.agent.interrupt(params.sessionId as string);
        return { ok };
      }

      case "session.close_session": {
        deps.log.info("Closing session", { sessionId: deps.sid(params.sessionId as string) });
        await deps.agent.close(params.sessionId as string);
        deps.requestState.requestContexts.delete(params.sessionId as string);
        deps.requestState.primaryContexts.delete(params.sessionId as string);
        const existing = deps.getStoredSession(params.sessionId as string);
        if (existing) {
          deps.upsertSession({
            id: existing.id,
            workspaceId: existing.workspaceId,
            providerSessionId: existing.providerSessionId,
            model: existing.model,
            agent: existing.agent,
            purpose: existing.purpose,
            parentSessionId: existing.parentSessionId,
            status: "archived",
            runtimeStatus: existing.runtimeStatus,
            title: existing.title,
            summary: existing.summary,
            metadata: existing.metadata,
            previousSessionId: existing.previousSessionId,
          });
        }
        deps.log.info("Session closed", { sessionId: deps.sid(params.sessionId as string) });
        return { ok: true };
      }

      case "session.list_sessions":
        return deps.sessionQuery.listSessions(params.cwd as string);

      case "session.get_history":
        return deps.sessionQuery.getHistory({
          sessionId: params.sessionId as string,
          cwd: params.cwd as string | undefined,
          limit: params.limit as number | undefined,
          offset: params.offset as number | undefined,
        });

      case "session.switch_session":
        return await deps.sessionActivation.switchSession({
          sessionId: params.sessionId as string,
          cwd: params.cwd as string,
          model: params.model as string | undefined,
        });

      case "session.reset_session":
        return await deps.sessionActivation.resetSession({
          cwd: params.cwd as string,
          model: params.model as string | undefined,
        });

      case "session.get_info": {
        const sessionId = params.sessionId as string | undefined;
        const activeSessions = await deps.agent.list();
        if (sessionId) {
          const session = activeSessions.find((entry) => entry.id === sessionId);
          return { session: session || null, activeSessions };
        }
        return { activeSessions };
      }

      case "session.set_permission_mode": {
        deps.log.info("Setting permission mode", {
          sessionId: deps.sid(params.sessionId as string),
          mode: params.mode,
        });
        const ok = await deps.agent.setPermissionMode(
          params.sessionId as string,
          params.mode as string,
        );
        return { ok };
      }

      case "session.send_tool_result": {
        deps.log.info("Sending tool result", {
          sessionId: deps.sid(params.sessionId as string),
          toolUseId: params.toolUseId,
          isError: params.isError,
        });
        const ok = await deps.agent.sendToolResult(
          params.sessionId as string,
          params.toolUseId as string,
          params.content as string,
          params.isError as boolean,
        );
        return { ok };
      }

      case "session.start_task": {
        const ctx = deps.getCtx();
        return await deps.taskWorkflow.startTask(
          {
            sessionId: params.sessionId as string,
            agent: params.agent as string,
            prompt: params.prompt as string,
            mode: normalizeTaskMode(params.mode as string | undefined),
            cwd: params.cwd as string | undefined,
            worktree: params.worktree as boolean | undefined,
            continue: params.continue as string | undefined,
            model: params.model as string | undefined,
            effort: params.effort as string | undefined,
            sandbox: params.sandbox as "read-only" | "workspace-write" | "danger-full-access",
            files: params.files as string[] | undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
          },
          {
            connectionId: ctx.connectionId,
            tags: ctx.tags,
          },
        );
      }

      case "session.get_task": {
        const result = await deps.agent.getTask(params.taskId as string);
        const hostTask = (result?.task || null) as SessionTask | null;
        if (hostTask) {
          deps.requestState.tasks.set(hostTask.taskId, hostTask);
        }
        const storedTask = deps.taskWorkflow.getTask(params.taskId as string);
        return { task: hostTask || storedTask || null };
      }

      case "session.list_tasks":
        return await deps.taskWorkflow.listTasks({
          sessionId: params.sessionId as string | undefined,
          status: params.status as TaskStatus | undefined,
          agent: params.agent as string | undefined,
        });

      case "session.interrupt_task":
        return await deps.taskWorkflow.interruptTask(params.taskId as string);

      case "session.send_notification": {
        const sessionId = params.sessionId as string;
        const text = params.text as string;
        const ctx = deps.getCtx();

        deps.log.info("Sending notification", {
          sessionId: deps.sid(sessionId),
          content: { kind: "text", chars: text.length },
        });

        await deps.taskEventBridge.sendSessionNotification(sessionId, text, {
          connectionId: ctx.connectionId,
          tags: ctx.tags,
        });

        return { ok: true, sessionId };
      }

      case "session.list_workspaces":
        return { workspaces: deps.listWorkspaces() };

      case "session.get_workspace":
        return { workspace: deps.getWorkspace(params.id as string) };

      case "session.get_or_create_workspace": {
        const cwd = params.cwd as string;
        const result = deps.getOrCreateWorkspace(
          cwd,
          params.name as string | undefined,
          params.general as boolean | undefined,
        );
        deps.log.info("Get/create workspace", {
          cwd,
          created: result.created,
          general: result.workspace.general,
        });
        return result;
      }

      case "session.delete_workspace":
        return { deleted: deps.deleteWorkspace(params.cwd as string) };

      case "session.get_directories": {
        const path = (params.path as string | undefined) || "~";
        return { path, directories: deps.getDirectories(path) };
      }

      case "session.health_check":
        return deps.healthCheckDetailed();

      case "session.rotate_persistent_sessions": {
        const ctx = deps.getCtx();
        const rotationConfig = (deps.config.persistentSessionRotation as {
          maxMessages?: number;
          maxAgeHours?: number;
        }) || { maxMessages: 200, maxAgeHours: 24 };
        const maxMessages = rotationConfig.maxMessages ?? 200;
        const maxAgeHours = rotationConfig.maxAgeHours ?? 24;
        return rotatePersistentSessions({
          store: {
            getEntries: () =>
              ctx.store.get<
                Record<string, { sessionId: string; messageCount: number; createdAt: string }>
              >("persistentSessions") || {},
            setEntries: (entries) => {
              ctx.store.set("persistentSessions", entries);
            },
          },
          maxMessages,
          maxAgeHours,
          log: deps.log,
          formatSessionId: deps.sid,
        });
      }

      case "session.get_memory_context":
        return await deps.sessionQuery.getMemoryContext(params.cwd as string | undefined);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  };
}
