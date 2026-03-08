import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskHost } from "./task-host";

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

    const host = new TaskHost({ codex: { apiKey: "test-key", model: "gpt-5.2-codex" } });
    const threadOptions: Array<Record<string, unknown>> = [];
    (host as unknown as { ensureCodex: () => Promise<unknown> }).ensureCodex = async () => ({
      startThread: (opts: Record<string, unknown>) => {
        threadOptions.push(opts);
        return {
          runStreamed: async () => ({
            events: (async function* () {})(),
          }),
        };
      },
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
    expect(threadOptions[0]?.workingDirectory).toBe(worktreePath);
    expect(runAndRead(["git", "-C", worktreePath, "branch", "--show-current"])).toBe(
      `task/${started.taskId}`,
    );
  });

  it("reuses /tmp/worktrees/<task_id> when continue is provided", async () => {
    const repoDir = initGitRepo();
    cleanupPaths.add(repoDir);

    const host = new TaskHost({ codex: { apiKey: "test-key", model: "gpt-5.2-codex" } });
    const threadOptions: Array<Record<string, unknown>> = [];
    (host as unknown as { ensureCodex: () => Promise<unknown> }).ensureCodex = async () => ({
      startThread: (opts: Record<string, unknown>) => {
        threadOptions.push(opts);
        return {
          runStreamed: async () => ({
            events: (async function* () {})(),
          }),
        };
      },
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

    expect(threadOptions[1]?.workingDirectory).toBe(firstWorktree);
    expect(existsSync(join("/tmp", "worktrees", second.taskId))).toBe(false);
    expect(runAndRead(["git", "-C", firstWorktree, "branch", "--show-current"])).toBe(
      `task/${first.taskId}`,
    );
  });
});
