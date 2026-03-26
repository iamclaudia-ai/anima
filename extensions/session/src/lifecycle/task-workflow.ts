import { existsSync } from "node:fs";
import type { StoredSession } from "../session-store";

export type TaskStatus = "running" | "completed" | "failed" | "interrupted";
export type TaskMode = "general" | "review" | "test";

export interface SessionTask {
  taskId: string;
  sessionId: string;
  agent: string;
  cwd?: string;
  worktreePath?: string;
  parentRepoPath?: string;
  continuedFromTaskId?: string;
  git?: Record<string, unknown>;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  startedAt: string;
  updatedAt: string;
  error?: string;
  outputFile?: string;
  context: {
    connectionId: string | null;
    tags: string[] | null;
  };
}

export function normalizeTaskMode(input?: string): TaskMode {
  if (input === "review" || input === "test") return input;
  return "general";
}

function toTaskStatus(input: string | undefined): TaskStatus {
  if (input === "completed" || input === "failed" || input === "interrupted") return input;
  return "running";
}

export function toSessionTaskFromStored(stored: StoredSession | null): SessionTask | null {
  if (!stored || !stored.parentSessionId) return null;
  const metadata = stored.metadata || {};
  const mode =
    stored.purpose === "review" || stored.purpose === "test" ? stored.purpose : "general";
  return {
    taskId: stored.id,
    sessionId: stored.parentSessionId,
    agent: stored.agent,
    cwd: typeof metadata.cwd === "string" ? metadata.cwd : undefined,
    worktreePath: typeof metadata.worktreePath === "string" ? metadata.worktreePath : undefined,
    parentRepoPath:
      typeof metadata.parentRepoPath === "string" ? metadata.parentRepoPath : undefined,
    continuedFromTaskId:
      typeof metadata.continuedFromTaskId === "string" ? metadata.continuedFromTaskId : undefined,
    git:
      metadata.git && typeof metadata.git === "object" && !Array.isArray(metadata.git)
        ? (metadata.git as Record<string, unknown>)
        : undefined,
    prompt: typeof metadata.prompt === "string" ? metadata.prompt : "",
    mode,
    status: toTaskStatus(stored.runtimeStatus),
    startedAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    error: typeof metadata.error === "string" ? metadata.error : undefined,
    outputFile: typeof metadata.outputFile === "string" ? metadata.outputFile : undefined,
    context: {
      connectionId: typeof metadata.connectionId === "string" ? metadata.connectionId : null,
      tags: Array.isArray(metadata.tags) ? (metadata.tags as string[]) : null,
    },
  };
}

export function getTaskGitInfo(
  cwd?: string,
  parentRepoPath?: string,
  worktreePath?: string,
): Record<string, unknown> | undefined {
  if (!cwd) return undefined;
  const runGit = (repoCwd: string, args: string[]): { ok: boolean; out: string } => {
    const proc = Bun.spawnSync(["git", "-C", repoCwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out =
      proc.stdout && proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "";
    return { ok: proc.exitCode === 0, out: out.trim() };
  };

  const status = runGit(cwd, ["status", "--porcelain=v1"]);
  if (!status.ok) return undefined;

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const lines = status.out ? status.out.split("\n").filter(Boolean) : [];
  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked += 1;
      continue;
    }
    const x = line[0] || " ";
    const y = line[1] || " ";
    if (x !== " ") staged += 1;
    if (y !== " ") unstaged += 1;
  }

  const branchOut = runGit(cwd, ["branch", "--show-current"]);
  const branchName = branchOut.ok && branchOut.out ? branchOut.out : undefined;
  const git: Record<string, unknown> = {
    isRepo: true,
    dirty: staged > 0 || unstaged > 0 || untracked > 0,
    staged,
    unstaged,
    untracked,
    branchName,
    branch: branchName,
  };

  if (worktreePath) {
    git.worktreeExists = existsSync(worktreePath);
  }

  if (worktreePath && parentRepoPath) {
    const taskHead = runGit(cwd, ["rev-parse", "HEAD"]);
    const parentHead = runGit(parentRepoPath, ["rev-parse", "HEAD"]);
    if (taskHead.ok && parentHead.ok && taskHead.out && parentHead.out) {
      const merged = runGit(parentRepoPath, [
        "merge-base",
        "--is-ancestor",
        taskHead.out,
        parentHead.out,
      ]);
      git.mergedToParent = merged.ok;
    }
  }

  return git;
}

interface AgentHostSessionInfoLike {
  id: string;
  cwd?: string;
}

interface StartTaskResult {
  taskId: string;
  outputFile?: string;
  status?: string;
  message?: string;
  cwd?: string;
  worktreePath?: string;
  parentRepoPath?: string;
  continuedFromTaskId?: string;
}

interface TaskWorkflowDeps {
  tasks: Map<string, SessionTask>;
  taskNotificationsSent: Set<string>;
  sessionConfig: { model: string };
  getStoredSession: (id: string) => StoredSession | null;
  getWorkspace: (id: string) => { cwd: string } | null;
  getOrCreateWorkspace: (cwd: string) => { workspace: { id: string } };
  listTaskSessions: (filters: {
    parentSessionId?: string;
    status?: TaskStatus;
    agent?: string;
  }) => StoredSession[];
  upsertSession: (params: {
    id: string;
    workspaceId: string;
    providerSessionId: string;
    model: string;
    agent: string;
    purpose: "chat" | "task" | "review" | "test";
    parentSessionId?: string | null;
    runtimeStatus: "running" | "completed" | "failed" | "interrupted";
    metadata?: Record<string, unknown> | null;
    lastActivity?: string;
    status?: "active" | "archived";
    title?: string | null;
    summary?: string | null;
    previousSessionId?: string | null;
  }) => void;
  listActiveSessions: () => Promise<AgentHostSessionInfoLike[]>;
  startTask: (params: {
    sessionId: string;
    agent: string;
    prompt: string;
    mode: TaskMode;
    cwd?: string;
    worktree?: boolean;
    continue?: string;
    model?: string;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    files?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<StartTaskResult>;
  listTasks: (params: {
    sessionId?: string;
    status?: TaskStatus;
    agent?: string;
  }) => Promise<{ tasks?: SessionTask[] }>;
  interruptTask: (taskId: string) => Promise<boolean>;
}

export interface TaskWorkflowRunner {
  startTask: (
    params: {
      sessionId: string;
      agent: string;
      prompt: string;
      mode: TaskMode;
      cwd?: string;
      worktree?: boolean;
      continue?: string;
      model?: string;
      effort?: string;
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      files?: string[];
      metadata?: Record<string, unknown>;
    },
    request: { connectionId: string | null; tags: string[] | null },
  ) => Promise<Record<string, unknown>>;
  getTask: (
    taskId: string,
    getStoredSession: (id: string) => StoredSession | null,
  ) => SessionTask | null;
  listTasks: (params: {
    sessionId?: string;
    status?: TaskStatus;
    agent?: string;
  }) => Promise<{ tasks: SessionTask[] }>;
  interruptTask: (taskId: string) => Promise<{ ok: boolean; taskId: string; error?: string }>;
}

export function createTaskWorkflowRunner(deps: TaskWorkflowDeps): TaskWorkflowRunner {
  return {
    startTask: async (params, request) => {
      const parentSession = deps.getStoredSession(params.sessionId);

      let effectiveCwd = params.cwd;
      if (!effectiveCwd && parentSession?.workspaceId) {
        const workspace = deps.getWorkspace(parentSession.workspaceId);
        effectiveCwd = workspace?.cwd;
      }
      if (!effectiveCwd) {
        const activeSessions = await deps.listActiveSessions();
        effectiveCwd = activeSessions.find((s) => s.id === params.sessionId)?.cwd;
      }

      const result = await deps.startTask({
        sessionId: params.sessionId,
        agent: params.agent,
        prompt: params.prompt,
        mode: params.mode,
        cwd: effectiveCwd,
        worktree: params.worktree,
        continue: params.continue,
        model: params.model,
        effort: params.effort,
        sandbox: params.sandbox,
        files: params.files,
        metadata: params.metadata,
      });

      const nowIso = new Date().toISOString();
      const workspaceId =
        parentSession?.workspaceId ||
        (effectiveCwd ? deps.getOrCreateWorkspace(effectiveCwd).workspace.id : null);
      if (!workspaceId) {
        throw new Error(`Unable to resolve workspace for parent session ${params.sessionId}`);
      }

      const task: SessionTask = {
        taskId: result.taskId,
        sessionId: params.sessionId,
        agent: params.agent,
        cwd: result.cwd || effectiveCwd,
        worktreePath: result.worktreePath,
        parentRepoPath: result.parentRepoPath,
        continuedFromTaskId: result.continuedFromTaskId,
        prompt: params.prompt,
        mode: params.mode,
        status: "running",
        startedAt: nowIso,
        updatedAt: nowIso,
        outputFile: result.outputFile,
        context: {
          connectionId: request.connectionId,
          tags: request.tags,
        },
      };
      deps.tasks.set(task.taskId, task);
      deps.taskNotificationsSent.delete(task.taskId);
      deps.upsertSession({
        id: task.taskId,
        workspaceId,
        providerSessionId: task.taskId,
        model: params.model || parentSession?.model || deps.sessionConfig.model,
        agent: task.agent,
        purpose: task.mode === "review" || task.mode === "test" ? task.mode : "task",
        parentSessionId: task.sessionId,
        runtimeStatus: "running",
        metadata: {
          prompt: task.prompt,
          cwd: task.cwd,
          worktreePath: task.worktreePath,
          parentRepoPath: task.parentRepoPath,
          continuedFromTaskId: task.continuedFromTaskId,
          outputFile: task.outputFile,
          connectionId: task.context.connectionId,
          tags: task.context.tags,
        },
        lastActivity: nowIso,
      });

      return {
        taskId: task.taskId,
        sessionId: task.sessionId,
        agent: task.agent,
        mode: task.mode,
        status: task.status,
        cwd: task.cwd,
        worktreePath: task.worktreePath,
        parentRepoPath: task.parentRepoPath,
        continuedFromTaskId: task.continuedFromTaskId,
        outputFile: task.outputFile,
        message: result.message || `Started ${params.agent} task`,
      };
    },

    getTask: (taskId, getStoredSession) => {
      return deps.tasks.get(taskId) || toSessionTaskFromStored(getStoredSession(taskId));
    },

    listTasks: async (params) => {
      const result = await deps.listTasks({
        sessionId: params.sessionId,
        status: params.status,
        agent: params.agent,
      });
      const hostTasks = result.tasks || [];
      for (const task of hostTasks) {
        deps.tasks.set(task.taskId, task);
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
              connectionId: task.context?.connectionId || null,
              tags: task.context?.tags || null,
            },
          });
        }
      }

      const stored = deps
        .listTaskSessions({
          parentSessionId: params.sessionId,
          status: params.status,
          agent: params.agent,
        })
        .map((row) => toSessionTaskFromStored(row))
        .filter((row): row is SessionTask => !!row);

      const merged = new Map<string, SessionTask>();
      for (const task of stored) merged.set(task.taskId, task);
      for (const task of hostTasks) merged.set(task.taskId, task);
      const hydrated = Array.from(merged.values()).map((task) => {
        if (!task.cwd) return task;
        const git = getTaskGitInfo(task.cwd, task.parentRepoPath, task.worktreePath);
        return git ? { ...task, git } : task;
      });
      return { tasks: hydrated };
    },

    interruptTask: async (taskId) => {
      const task = deps.tasks.get(taskId) || toSessionTaskFromStored(deps.getStoredSession(taskId));
      if (!task) {
        return { ok: false, error: "Task not found", taskId };
      }

      const ok = await deps.interruptTask(taskId);
      if (ok) {
        task.status = "interrupted";
        task.updatedAt = new Date().toISOString();
        const stored = deps.getStoredSession(taskId);
        if (stored) {
          deps.upsertSession({
            id: stored.id,
            workspaceId: stored.workspaceId,
            providerSessionId: stored.providerSessionId,
            model: stored.model,
            agent: stored.agent,
            purpose: stored.purpose,
            parentSessionId: stored.parentSessionId!,
            runtimeStatus: "interrupted",
            status: stored.status,
            title: stored.title,
            summary: stored.summary,
            metadata: { ...(stored.metadata || {}), interruptedAt: task.updatedAt },
            previousSessionId: stored.previousSessionId,
          });
        }
      }
      return { ok, taskId };
    },
  };
}
