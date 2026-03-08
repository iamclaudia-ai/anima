import { EventEmitter } from "node:events";
import { createLogger } from "@claudia/shared";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { EventBuffer, type BufferedEvent } from "./event-buffer";

const log = createLogger("TaskHost", join(homedir(), ".claudia", "logs", "agent-host.log"));

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
  abortController: AbortController;
  threadId: string | null;
  items: any[];
}

export interface TaskHostConfig {
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

function summarizeItem(item: any): Record<string, unknown> {
  const base: Record<string, unknown> = { type: item.type, id: item.id };
  if (item.type === "agent_message") base.text = item.text;
  if (item.type === "command_execution") {
    base.command = item.command;
    base.exitCode = item.exit_code;
    base.status = item.status;
  }
  if (item.type === "file_change") {
    base.changes = item.changes;
    base.status = item.status;
  }
  return base;
}

let taskCounter = 0;
function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${(++taskCounter).toString(36)}`;
}

export class TaskHost extends EventEmitter {
  private codex: any | null = null;
  private records = new Map<string, TaskRecord>();
  private activeTasks = new Map<string, ActiveTask>();
  private buffers = new Map<string, EventBuffer>();
  private outputDir: string;

  constructor(private cfg: TaskHostConfig = {}) {
    super();
    this.outputDir = join(process.env.CLAUDIA_DATA_DIR || join(homedir(), ".claudia"), "codex");
    ensureDir(this.outputDir);
  }

  private resolveGitRoot(cwd: string): string | null {
    const out = runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (!out.ok) return null;
    const root = out.stdout;
    return root || null;
  }

  private resolveTaskWorkingDirectory(
    taskId: string,
    params: TaskStartParams,
  ): {
    cwd: string;
    worktreePath?: string;
    parentRepoPath?: string;
    continuedFromTaskId?: string;
  } {
    const baseCwd = params.cwd || this.cfg.codex?.cwd || process.cwd();
    const continueTaskId = params.continue?.trim();
    const parentRepoPath = this.resolveGitRoot(baseCwd) || undefined;

    if (continueTaskId) {
      const continuePath = join("/tmp", "worktrees", continueTaskId);
      if (existsSync(continuePath)) {
        log.info("Reusing task worktree", { taskId, continueTaskId, path: continuePath });
        return {
          cwd: continuePath,
          worktreePath: continuePath,
          parentRepoPath,
          continuedFromTaskId: continueTaskId,
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
    ensureDir(dirname(worktreePath));
    if (!existsSync(worktreePath)) {
      const add = runGit(parentRepoPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
      if (!add.ok) {
        const stderr = add.stderr;
        throw new Error(`Failed to create worktree ${worktreePath}: ${stderr || "unknown error"}`);
      }
      log.info("Created task worktree", { taskId, gitRoot: parentRepoPath, worktreePath });
    }

    return { cwd: worktreePath, worktreePath, parentRepoPath };
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
        // First check: exact ancestry (works for git merge)
        const merged = runGit(record.parentRepoPath, [
          "merge-base",
          "--is-ancestor",
          taskHead.stdout,
          parentHead.stdout,
        ]);
        if (merged.ok) {
          state.mergedToParent = true;
        } else {
          // Fallback: patch-id comparison (detects cherry-picks)
          state.mergedToParent = this.isPatchInParent(record);
        }
      }
    }

    return state;
  }

  /**
   * Check if the worktree HEAD's patch has been cherry-picked into the parent repo.
   * Compares git patch-ids which are content-based, ignoring commit SHA differences.
   */
  private isPatchInParent(record: TaskRecord): boolean {
    if (!record.cwd || !record.parentRepoPath) return false;

    // Get the worktree HEAD's patch-id
    const taskShow = runGit(record.cwd, ["show", "HEAD"]);
    if (!taskShow.ok || !taskShow.stdout) return false;

    const taskPatchId = Bun.spawnSync(["git", "patch-id", "--stable"], {
      stdin: Buffer.from(taskShow.stdout),
    });
    const taskPid = taskPatchId.stdout?.toString().trim().split(/\s+/)[0];
    if (!taskPid) return false;

    // Check recent parent commits (last 50) for a matching patch-id
    const parentLog = runGit(record.parentRepoPath, ["log", "--format=%H", "-50"]);
    if (!parentLog.ok || !parentLog.stdout) return false;

    for (const sha of parentLog.stdout.split("\n").filter(Boolean)) {
      const parentShow = runGit(record.parentRepoPath, ["show", sha]);
      if (!parentShow.ok || !parentShow.stdout) continue;

      const parentPatchId = Bun.spawnSync(["git", "patch-id", "--stable"], {
        stdin: Buffer.from(parentShow.stdout),
      });
      const parentPid = parentPatchId.stdout?.toString().trim().split(/\s+/)[0];
      if (parentPid === taskPid) return true;
    }

    return false;
  }

  private hydrateRecord(record: TaskRecord): TaskRecord {
    const git = this.getGitState(record);
    return {
      ...record,
      ...(git ? { git } : {}),
    };
  }

  private async ensureCodex(): Promise<any> {
    if (this.codex) return this.codex;
    const apiKey = this.cfg.codex?.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Codex API key missing for task agent");
    const candidates = [
      join(process.cwd(), "node_modules", "@openai", "codex-sdk"),
      join(process.cwd(), "node_modules", ".bun", "node_modules", "@openai", "codex-sdk"),
      join(process.cwd(), "extensions", "codex", "node_modules", "@openai", "codex-sdk"),
    ];

    let moduleImpl: { Codex?: new (opts: Record<string, unknown>) => any } | null = null;
    for (const candidate of candidates) {
      try {
        moduleImpl = (await import(candidate)) as {
          Codex?: new (opts: Record<string, unknown>) => any;
        };
        break;
      } catch {
        // try next
      }
    }
    if (!moduleImpl?.Codex) {
      throw new Error("Failed to load @openai/codex-sdk for agent-host task runtime");
    }

    this.codex = new moduleImpl.Codex({
      apiKey,
      ...(this.cfg.codex?.cliPath ? { codexPathOverride: this.cfg.codex.cliPath } : {}),
    });
    return this.codex;
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
    active.abortController.abort();
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
    if (params.agent !== "codex") {
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
      abortController: new AbortController(),
      threadId: null,
      items: [],
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

    const sdk = await this.ensureCodex();
    const threadOptions = {
      workingDirectory: runtime.cwd,
      skipGitRepoCheck: true,
      model: params.model || this.cfg.codex?.model,
      sandboxMode: params.sandbox || this.cfg.codex?.sandboxMode || "workspace-write",
      modelReasoningEffort: params.effort || this.cfg.codex?.effort || "medium",
      approvalPolicy: this.cfg.codex?.autoApprove === false ? "on-request" : "never",
      webSearchEnabled: false,
    };

    const thread = sdk.startThread(threadOptions);
    const preamble =
      mode === "review"
        ? this.cfg.codex?.preambles?.review
        : mode === "test"
          ? this.cfg.codex?.preambles?.test
          : this.cfg.codex?.preambles?.task;
    const fullPrompt = preamble ? `${preamble}\n\n${prompt}` : prompt;

    void this.runTaskStream(thread, active, fullPrompt);

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

  private async runTaskStream(thread: any, task: ActiveTask, prompt: string): Promise<void> {
    try {
      const { events } = await thread.runStreamed(prompt, {
        signal: task.abortController.signal,
      });

      for await (const event of events) {
        this.bridgeEvent(task, event);
      }

      if (task.status === "running" && !task.abortController.signal.aborted) {
        task.status = "completed";
        task.updatedAt = new Date().toISOString();
        this.records.set(task.taskId, { ...task });
        this.emitTaskEvent(task.taskId, {
          type: "stop",
          taskId: task.taskId,
          status: task.status,
          cwd: task.cwd,
          worktreePath: task.worktreePath,
          parentRepoPath: task.parentRepoPath,
          continuedFromTaskId: task.continuedFromTaskId,
          git: this.getGitState(task),
          result: task.resultText || "",
          items: task.items.map(summarizeItem),
          outputFile: task.outputFile,
        });
      }
    } catch (err: unknown) {
      if (task.status !== "running") return;
      const message = err instanceof Error ? err.message : String(err);
      const isAbort =
        message.toLowerCase().includes("abort") || message.toLowerCase().includes("cancel");
      task.status = isAbort ? "interrupted" : "failed";
      task.error = isAbort ? undefined : message;
      task.updatedAt = new Date().toISOString();
      this.records.set(task.taskId, { ...task });
      this.emitTaskEvent(task.taskId, {
        type: isAbort ? "stop" : "error",
        taskId: task.taskId,
        status: task.status,
        cwd: task.cwd,
        worktreePath: task.worktreePath,
        parentRepoPath: task.parentRepoPath,
        continuedFromTaskId: task.continuedFromTaskId,
        git: this.getGitState(task),
        error: task.error,
        result: task.resultText || "",
        outputFile: task.outputFile,
      });
    } finally {
      this.activeTasks.delete(task.taskId);
    }
  }

  private bridgeEvent(task: ActiveTask, event: any): void {
    if (event.type === "thread.started") {
      task.threadId = event.thread_id;
      return;
    }

    if (event.type === "item.updated" && event.item.type === "agent_message") {
      this.emitTaskEvent(task.taskId, {
        type: "delta",
        taskId: task.taskId,
        text: event.item.text,
      });
      return;
    }

    if (event.type === "item.completed") {
      task.items.push(event.item);
      if (event.item.type === "agent_message") {
        task.resultText = `${task.resultText || ""}${task.resultText ? "\n" : ""}${event.item.text}`;
        if (task.outputFile) this.appendOutput(task.outputFile, `${event.item.text}\n`);
      }
      this.emitTaskEvent(task.taskId, {
        type: "item",
        taskId: task.taskId,
        itemType: event.item.type,
        item: summarizeItem(event.item),
      });
      return;
    }

    if (event.type === "turn.failed" || event.type === "error") {
      const error = event.type === "turn.failed" ? event.error.message : event.message;
      task.status = "failed";
      task.error = error;
      task.updatedAt = new Date().toISOString();
      this.records.set(task.taskId, { ...task });
      this.emitTaskEvent(task.taskId, {
        type: "error",
        taskId: task.taskId,
        cwd: task.cwd,
        worktreePath: task.worktreePath,
        parentRepoPath: task.parentRepoPath,
        continuedFromTaskId: task.continuedFromTaskId,
        git: this.getGitState(task),
        error,
        outputFile: task.outputFile,
      });
    }
  }
}
