import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { TaskHost } from "./task-host";
import type {
  AgentRuntimeFactory,
  AgentRuntimeSession,
  AgentRuntimeSessionInfo,
  CreateSessionOptions,
  StreamEvent,
} from "./provider-types";

function runOrThrow(cmd: string[], cwd?: string): void {
  const proc = Bun.spawnSync(cmd, {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) return;
  const stderr = new TextDecoder().decode(proc.stderr);
  throw new Error(`Command failed (${cmd.join(" ")}): ${stderr}`);
}

function runAndRead(cmd: string[], cwd?: string): string {
  const proc = Bun.spawnSync(cmd, {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr);
    throw new Error(`Command failed (${cmd.join(" ")}): ${stderr}`);
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

function initGitRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "claudia-task-host-"));
  runOrThrow(["git", "init"], repoDir);
  runOrThrow(["git", "config", "user.name", "Claudia Test"], repoDir);
  runOrThrow(["git", "config", "user.email", "test@claudia.local"], repoDir);
  writeFileSync(join(repoDir, "README.md"), "# test\n", "utf-8");
  runOrThrow(["git", "add", "."], repoDir);
  runOrThrow(["git", "commit", "-m", "init"], repoDir);
  return repoDir;
}

class FakeTaskRuntime extends EventEmitter implements AgentRuntimeSession {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  isActive = false;
  isProcessRunning = false;

  constructor(
    options: CreateSessionOptions,
    private readonly events: StreamEvent[] = [{ type: "turn_stop", stop_reason: "end_turn" }],
  ) {
    super();
    this.id = options.sessionId || "fake-task";
    this.cwd = options.cwd;
    this.model = options.model || "fake-model";
  }

  async start(): Promise<void> {
    this.isActive = true;
  }

  prompt(): void {
    this.isProcessRunning = true;
    queueMicrotask(() => {
      for (const event of this.events) this.emit("sse", event);
      this.isProcessRunning = false;
    });
  }

  interrupt(): void {
    this.emit("sse", { type: "turn_stop", stop_reason: "abort" });
  }

  async close(): Promise<void> {
    this.isActive = false;
    this.emit("closed");
  }

  setPermissionMode(): void {}

  sendToolResult(): void {}

  getInfo(): AgentRuntimeSessionInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      healthy: this.isActive,
      stale: false,
    };
  }
}

function fakeProvider(
  created: CreateSessionOptions[],
  events?: StreamEvent[],
): AgentRuntimeFactory {
  return {
    create: (options) => {
      created.push(options);
      return new FakeTaskRuntime(options, events);
    },
    resume: (sessionId, options) => new FakeTaskRuntime({ ...options, sessionId }, events),
  };
}

describe("TaskHost worktree options", () => {
  const cleanupPaths = new Set<string>();

  afterEach(() => {
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  it("creates /tmp/worktrees/<task_id> when worktree=true", async () => {
    const repoDir = initGitRepo();
    cleanupPaths.add(repoDir);

    const createdOptions: CreateSessionOptions[] = [];
    const host = new TaskHost({
      providers: { codex: fakeProvider(createdOptions) },
    });

    const started = await host.start({
      sessionId: "ses_1",
      agent: "codex",
      prompt: "refactor this",
      cwd: repoDir,
      worktree: true,
    });

    const worktreePath = join("/tmp", "worktrees", started.taskId);
    cleanupPaths.add(worktreePath);
    expect(existsSync(worktreePath)).toBe(true);
    expect(createdOptions[0]?.cwd).toBe(worktreePath);
    expect(runAndRead(["git", "-C", worktreePath, "branch", "--show-current"])).toBe(
      `task/${started.taskId}`,
    );
  });

  it("reuses /tmp/worktrees/<task_id> when continue is provided", async () => {
    const repoDir = initGitRepo();
    cleanupPaths.add(repoDir);

    const createdOptions: CreateSessionOptions[] = [];
    const host = new TaskHost({
      providers: { codex: fakeProvider(createdOptions) },
    });

    const first = await host.start({
      sessionId: "ses_1",
      agent: "codex",
      prompt: "task one",
      cwd: repoDir,
      worktree: true,
    });
    const firstWorktree = join("/tmp", "worktrees", first.taskId);
    cleanupPaths.add(firstWorktree);
    expect(existsSync(firstWorktree)).toBe(true);
    // Simulate legacy detached worktree then verify continue auto-attaches a branch.
    runOrThrow(["git", "switch", "--detach"], firstWorktree);
    expect(runAndRead(["git", "-C", firstWorktree, "branch", "--show-current"])).toBe("");

    const second = await host.start({
      sessionId: "ses_1",
      agent: "codex",
      prompt: "continue task one",
      cwd: repoDir,
      continue: first.taskId,
    });
    cleanupPaths.add(join("/tmp", "worktrees", second.taskId));

    expect(createdOptions[1]?.cwd).toBe(firstWorktree);
    expect(existsSync(join("/tmp", "worktrees", second.taskId))).toBe(false);
    expect(runAndRead(["git", "-C", firstWorktree, "branch", "--show-current"])).toBe(
      `task/${first.taskId}`,
    );
  });

  it("runs non-codex task agents through the shared runtime provider interface", async () => {
    const repoDir = initGitRepo();
    cleanupPaths.add(repoDir);

    const createdOptions: CreateSessionOptions[] = [];
    const host = new TaskHost({
      providers: {
        claude: fakeProvider(createdOptions, [
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "done" },
          },
          { type: "turn_stop", stop_reason: "end_turn" },
        ]),
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    host.on("task.event", (msg) => emitted.push(msg.event));

    const started = await host.start({
      sessionId: "ses_1",
      agent: "claude",
      prompt: "review this",
      cwd: repoDir,
      mode: "review",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started.status).toBe("running");
    expect(createdOptions[0]?.cwd).toBe(repoDir);
    expect(emitted.some((event) => event.type === "delta" && event.text === "done")).toBe(true);
    expect(host.get(started.taskId)?.status).toBe("completed");
  });
});
