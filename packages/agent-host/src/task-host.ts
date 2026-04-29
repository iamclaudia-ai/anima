import { EventEmitter } from "node:events";
import { createLogger, type ThinkingEffort } from "@anima/shared";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { EventBuffer, type BufferedEvent } from "./event-buffer";
import { createCodexProvider } from "./providers/codex/session";
import type { AgentRuntimeProviders, AgentRuntimeSession, StreamEvent } from "./provider-types";

const log = createLogger("TaskHost", join(homedir(), ".anima", "logs", "agent-host.log"));

type TaskStatus = "running" | "completed" | "failed" | "interrupted";
type TaskMode = "general" | "review" | "test";

export interface TaskStartParams {
  sessionId: string;
  agent: string;
  prompt: string;
  mode?: string;
  cwd?: string;
  worktree?: boolean;
  continue?: string;
  model?: string;
  effort?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskGitState {
  isRepo: boolean;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  branchName?: string;
  branch?: string;
  worktreeExists?: boolean;
  mergedToParent?: boolean;
}

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  agent: string;
  cwd: string;
  worktreePath?: string;
  parentRepoPath?: string;
  continuedFromTaskId?: string;
  mode: TaskMode;
  prompt: string;
  status: TaskStatus;
  startedAt: string;
  updatedAt: string;
  outputFile?: string;
  error?: string;
  resultText?: string;
  git?: TaskGitState;
}

interface ActiveTask extends TaskRecord {
  runtime: AgentRuntimeSession;
}

export interface TaskHostConfig {
  providers?: AgentRuntimeProviders;
  preambles?: {
    task?: string;
    review?: string;
    test?: string;
  };
  codex?: {
    apiKey?: string;
    cliPath?: string;
    model?: string;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    autoApprove?: boolean;
    personality?: string;
    cwd?: string;
    preambles?: {
      task?: string;
      review?: string;
      test?: string;
    };
  };
}

function normalizeMode(mode?: string): TaskMode {
  if (mode === "review" || mode === "test") return mode;
  return "general";
}

function normalizeEffort(effort?: string): ThinkingEffort | undefined {
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
    return effort;
  }
  return undefined;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function decodeOutput(data: Uint8Array | null | undefined): string {
  if (!data) return "";
  return new TextDecoder().decode(data).trim();
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: decodeOutput(proc.stdout),
    stderr: decodeOutput(proc.stderr),
  };
}

function sanitizeBranchSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-");
}

let taskCounter = 0;
function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${(++taskCounter).toString(36)}`;
}

export class TaskHost extends EventEmitter {
  private records = new Map<string, TaskRecord>();
  private activeTasks = new Map<string, ActiveTask>();
  private buffers = new Map<string, EventBuffer>();
  private outputDir: string;
  private providers: AgentRuntimeProviders;

  constructor(private cfg: TaskHostConfig = {}) {
    super();
    this.outputDir = join(process.env.ANIMA_DATA_DIR || join(homedir(), ".anima"), "tasks");
    this.providers = cfg.providers || {
      codex: createCodexProvider(cfg.codex),
    };
    ensureDir(this.outputDir);
  }

  private resolveGitRoot(cwd: string): string | null {
    const out = runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (!out.ok) return null;
    const root = out.stdout;
    return root || null;
  }

  private ensureWorktreeBranch(cwd: string, preferredBranch: string): string | undefined {
    const current = runGit(cwd, ["branch", "--show-current"]);
    if (current.ok && current.stdout) {
      return current.stdout;
    }

    const switched = runGit(cwd, ["switch", preferredBranch]);
    if (switched.ok) {
      return preferredBranch;
    }

    const created = runGit(cwd, ["switch", "-c", preferredBranch]);
    if (created.ok) {
      return preferredBranch;
    }

    log.warn("Failed to attach detached worktree to branch", {
      cwd,
      preferredBranch,
      switchError: switched.stderr,
      createError: created.stderr,
    });
    return undefined;
  }

  private resolveTaskWorkingDirectory(
    taskId: string,
    params: TaskStartParams,
  ): {
    cwd: string;
    worktreePath?: string;
    parentRepoPath?: string;
    continuedFromTaskId?: string;
    branchName?: string;
  } {
    const baseCwd = params.cwd || this.cfg.codex?.cwd || process.cwd();
    const continueTaskId = params.continue?.trim();
    const parentRepoPath = this.resolveGitRoot(baseCwd) || undefined;

    if (continueTaskId) {
      const continuePath = join("/tmp", "worktrees", continueTaskId);
      if (existsSync(continuePath)) {
        const branchName = this.ensureWorktreeBranch(
          continuePath,
          `task/${sanitizeBranchSuffix(continueTaskId)}`,
        );
        log.info("Reusing task worktree", { taskId, continueTaskId, path: continuePath });
        return {
          cwd: continuePath,
          worktreePath: continuePath,
          parentRepoPath,
          continuedFromTaskId: continueTaskId,
          ...(branchName ? { branchName } : {}),
        };
      }
      log.info("Requested continue task worktree not found; using base cwd", {
        taskId,
        continueTaskId,
        baseCwd,
      });
      return { cwd: baseCwd, parentRepoPath, continuedFromTaskId: continueTaskId };
    }

    if (!params.worktree) {
      return { cwd: baseCwd, parentRepoPath };
    }

    if (!parentRepoPath) {
      throw new Error(`Cannot create worktree: ${baseCwd} is not inside a git repository`);
    }

    const worktreePath = join("/tmp", "worktrees", taskId);
    const branchName = `task/${sanitizeBranchSuffix(taskId)}`;
    ensureDir(dirname(worktreePath));
    if (!existsSync(worktreePath)) {
      const add = runGit(parentRepoPath, [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        "HEAD",
      ]);
      if (!add.ok) {
        const stderr = add.stderr;
        throw new Error(`Failed to create worktree ${worktreePath}: ${stderr || "unknown error"}`);
      }
      log.info("Created task worktree", { taskId, gitRoot: parentRepoPath, worktreePath });
    }

    return { cwd: worktreePath, worktreePath, parentRepoPath, branchName };
  }

  private getGitState(record: TaskRecord): TaskGitState | undefined {
    const status = runGit(record.cwd, ["status", "--porcelain=v1"]);
    if (!status.ok) return undefined;

    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    const lines = status.stdout ? status.stdout.split("\n").filter(Boolean) : [];
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

    const branchOut = runGit(record.cwd, ["branch", "--show-current"]);
    const branchName = branchOut.ok ? branchOut.stdout || undefined : undefined;
    const dirty = staged > 0 || unstaged > 0 || untracked > 0;
    const state: TaskGitState = {
      isRepo: true,
      dirty,
      staged,
      unstaged,
      untracked,
      branchName,
      branch: branchName,
      ...(record.worktreePath ? { worktreeExists: existsSync(record.worktreePath) } : {}),
    };

    if (record.worktreePath && record.parentRepoPath) {
      const taskHead = runGit(record.cwd, ["rev-parse", "HEAD"]);
      const parentHead = runGit(record.parentRepoPath, ["rev-parse", "HEAD"]);
      if (taskHead.ok && parentHead.ok && taskHead.stdout && parentHead.stdout) {
        const merged = runGit(record.parentRepoPath, [
          "merge-base",
          "--is-ancestor",
          taskHead.stdout,
          parentHead.stdout,
        ]);
        state.mergedToParent = merged.ok;
      }
    }

    return state;
  }

  private hydrateRecord(record: TaskRecord): TaskRecord {
    const git = this.getGitState(record);
    return {
      ...record,
      ...(git ? { git } : {}),
    };
  }

  private initOutput(taskId: string, mode: TaskMode, prompt: string): string {
    const path = join(this.outputDir, `${taskId}.md`);
    writeFileSync(
      path,
      `# Task ${taskId}\n\n**Mode:** ${mode}\n**Started:** ${new Date().toISOString()}\n\n## Prompt\n\n${prompt}\n\n## Output\n\n`,
      "utf-8",
    );
    return path;
  }

  private appendOutput(path: string, text: string): void {
    try {
      appendFileSync(path, text, "utf-8");
    } catch {
      // best effort
    }
  }

  private emitTaskEvent(taskId: string, event: Record<string, unknown>): void {
    const buffer = this.buffers.get(taskId) || new EventBuffer();
    this.buffers.set(taskId, buffer);
    const seq = buffer.push(event);
    this.emit("task.event", {
      type: "task.event",
      taskId,
      event,
      seq,
    });
  }

  getEventsAfter(taskId: string, lastSeq: number): BufferedEvent[] {
    const buffer = this.buffers.get(taskId);
    if (!buffer) return [];
    return buffer.getAfter(lastSeq);
  }

  get(taskId: string): TaskRecord | null {
    const record = this.records.get(taskId);
    if (!record) return null;
    return this.hydrateRecord(record);
  }

  list(filters?: { sessionId?: string; status?: string; agent?: string }): TaskRecord[] {
    const all = Array.from(this.records.values());
    return all
      .filter((t) => {
        if (filters?.sessionId && t.sessionId !== filters.sessionId) return false;
        if (filters?.status && t.status !== filters.status) return false;
        if (filters?.agent && t.agent !== filters.agent) return false;
        return true;
      })
      .map((record) => this.hydrateRecord(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  interrupt(taskId: string): boolean {
    const active = this.activeTasks.get(taskId);
    if (!active) return false;
    active.runtime.interrupt();
    return true;
  }

  async start(params: TaskStartParams): Promise<{
    taskId: string;
    status: TaskStatus;
    outputFile?: string;
    message: string;
    cwd?: string;
    worktreePath?: string;
    parentRepoPath?: string;
    continuedFromTaskId?: string;
  }> {
    const provider = this.providers[params.agent];
    if (!provider) {
      throw new Error(`Unsupported task agent: ${params.agent}`);
    }

    const taskId = newTaskId();
    const mode = normalizeMode(params.mode);
    const prompt = params.prompt;
    const now = new Date().toISOString();
    const outputFile = this.initOutput(taskId, mode, prompt);

    const runtime = this.resolveTaskWorkingDirectory(taskId, params);
    const record: TaskRecord = {
      taskId,
      sessionId: params.sessionId,
      agent: params.agent,
      cwd: runtime.cwd,
      worktreePath: runtime.worktreePath,
      parentRepoPath: runtime.parentRepoPath,
      continuedFromTaskId: runtime.continuedFromTaskId,
      mode,
      prompt,
      status: "running",
      startedAt: now,
      updatedAt: now,
      outputFile,
      resultText: "",
    };
    this.records.set(taskId, record);

    const active: ActiveTask = {
      ...record,
      runtime: provider.create({
        sessionId: taskId,
        cwd: runtime.cwd,
        model: params.model || (params.agent === "codex" ? this.cfg.codex?.model : undefined),
        effort: normalizeEffort(params.effort),
        sandbox:
          params.sandbox || (params.agent === "codex" ? this.cfg.codex?.sandboxMode : undefined),
      }),
    };
    this.activeTasks.set(taskId, active);

    this.emitTaskEvent(taskId, {
      type: "start",
      taskId,
      sessionId: params.sessionId,
      agent: params.agent,
      mode,
      cwd: record.cwd,
      worktreePath: record.worktreePath,
      parentRepoPath: record.parentRepoPath,
      continuedFromTaskId: record.continuedFromTaskId,
      outputFile,
    });

    const preambles = this.cfg.preambles || this.cfg.codex?.preambles;
    const preamble =
      mode === "review" ? preambles?.review : mode === "test" ? preambles?.test : preambles?.task;
    const fullPrompt = preamble ? `${preamble}\n\n${prompt}` : prompt;

    void this.runTaskSession(active, fullPrompt);

    return {
      taskId,
      status: "running",
      outputFile,
      message: "Task started",
      cwd: runtime.cwd,
      ...(runtime.worktreePath ? { worktreePath: runtime.worktreePath } : {}),
      ...(runtime.parentRepoPath ? { parentRepoPath: runtime.parentRepoPath } : {}),
      ...(runtime.continuedFromTaskId ? { continuedFromTaskId: runtime.continuedFromTaskId } : {}),
    };
  }

  private async runTaskSession(task: ActiveTask, prompt: string): Promise<void> {
    let finished = false;
    const finish = async (
      status: TaskStatus,
      payload: { error?: string; result?: string } = {},
    ): Promise<void> => {
      if (finished || task.status !== "running") return;
      finished = true;
      task.status = status;
      task.error = payload.error;
      task.updatedAt = new Date().toISOString();
      const { runtime: _runtime, ...record } = task;
      this.records.set(task.taskId, record);

      this.emitTaskEvent(task.taskId, {
        type: status === "failed" ? "error" : "stop",
        taskId: task.taskId,
        status: task.status,
        cwd: task.cwd,
        worktreePath: task.worktreePath,
        parentRepoPath: task.parentRepoPath,
        continuedFromTaskId: task.continuedFromTaskId,
        git: this.getGitState(task),
        error: task.error,
        result: payload.result || task.resultText || "",
        outputFile: task.outputFile,
      });

      this.activeTasks.delete(task.taskId);
      try {
        await task.runtime.close();
      } catch {
        // best effort cleanup
      }
    };

    task.runtime.on("sse", (event) => {
      this.bridgeRuntimeEvent(task, event);
      if (event.type === "turn_stop") {
        const stopReason = String(event.stop_reason || "");
        void finish(stopReason === "abort" ? "interrupted" : "completed");
      } else if (event.type === "process_died") {
        void finish("failed", { error: String(event.reason || "Task runtime failed") });
      }
    });

    try {
      await task.runtime.start();
      await task.runtime.prompt(prompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isAbort =
        message.toLowerCase().includes("abort") || message.toLowerCase().includes("cancel");
      await finish(isAbort ? "interrupted" : "failed", {
        error: isAbort ? undefined : message,
      });
    }
  }

  private bridgeRuntimeEvent(task: ActiveTask, event: StreamEvent): void {
    if (event.type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type !== "text_delta" || !delta.text) return;
      task.resultText = `${task.resultText || ""}${delta.text}`;
      if (task.outputFile) this.appendOutput(task.outputFile, delta.text);
      this.emitTaskEvent(task.taskId, {
        type: "delta",
        taskId: task.taskId,
        text: delta.text,
      });
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "content_block_start" ||
      event.type === "content_block_stop" ||
      event.type === "message_stop" ||
      event.type === "turn_stop" ||
      event.type === "process_died"
    ) {
      return;
    }

    this.emitTaskEvent(task.taskId, {
      type: "item",
      taskId: task.taskId,
      itemType: event.type,
      item: event,
    });
  }
}
