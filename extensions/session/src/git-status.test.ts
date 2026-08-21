/**
 * Real-repo tests for the git status collector.
 *
 * These build actual repositories in a temp dir and drive them into the states
 * that broke the status bar — chiefly a paused rebase, where HEAD is detached
 * and `rev-parse --abbrev-ref HEAD` answers the literal string `HEAD`. Mocking
 * git here would only assert that our mock matches our belief about git; the
 * bug was that our belief was wrong.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { collectGitStatus } from "./git-status";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A repo on `main` with one commit. */
async function makeRepo(name: string): Promise<string> {
  const cwd = join(root, name);
  await Bun.write(join(cwd, "file.txt"), "base\n");
  await git(cwd, "init", "-q", "-b", "main", ".");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "base");
  return cwd;
}

/** Drive `cwd` into a rebase paused on a conflict in file.txt. */
async function conflictedRebase(cwd: string): Promise<void> {
  await git(cwd, "checkout", "-qb", "feature");
  await Bun.write(join(cwd, "file.txt"), "feature\n");
  await git(cwd, "commit", "-qam", "feature edit");
  await git(cwd, "checkout", "-q", "main");
  await Bun.write(join(cwd, "file.txt"), "main\n");
  await git(cwd, "commit", "-qam", "main edit");
  await git(cwd, "checkout", "-q", "feature");
  await git(cwd, "rebase", "main"); // stops on conflict
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "anima-git-status-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("collectGitStatus", () => {
  it("reports the branch and a clean tree at rest", async () => {
    const cwd = await makeRepo("at-rest");
    const status = await collectGitStatus(cwd);

    expect(status.branch).toBe("main");
    expect(status.detached).toBe(false);
    expect(status.operation).toBeNull();
    expect(status.dirty.total).toBe(0);
    expect(status.dirty.conflicted).toBe(0);
  });

  it("counts an untracked file", async () => {
    const cwd = await makeRepo("untracked");
    await Bun.write(join(cwd, "new.txt"), "hi\n");
    const status = await collectGitStatus(cwd);

    expect(status.dirty.untracked).toBe(1);
    expect(status.dirty.total).toBe(1);
  });

  it("keeps the branch name through a paused rebase", async () => {
    // The regression: HEAD is detached here, so the old collector returned
    // `branch: null` and the UI unmounted the whole bar.
    const cwd = await makeRepo("rebasing");
    await conflictedRebase(cwd);
    const status = await collectGitStatus(cwd);

    expect(status.branch).toBe("feature");
    expect(status.detached).toBe(false);
    expect(status.operation).toBe("rebase");
  });

  it("counts conflicted paths instead of reporting a clean tree", async () => {
    // The second half of the regression: the null branch short-circuited
    // collection, so a tree full of conflict markers came back with zeroes.
    const cwd = await makeRepo("conflicts");
    await conflictedRebase(cwd);
    const status = await collectGitStatus(cwd);

    expect(status.dirty.conflicted).toBe(1);
    expect(status.dirty.total).toBe(1);
    // `UU` must not be miscounted as an ordinary edit.
    expect(status.dirty.modified).toBe(0);
  });

  it("reports a detached HEAD as a short SHA", async () => {
    const cwd = await makeRepo("detached");
    await git(cwd, "checkout", "-q", "--detach", "HEAD");
    const status = await collectGitStatus(cwd);

    expect(status.detached).toBe(true);
    expect(status.branch).toMatch(/^[0-9a-f]{7,}$/);
    expect(status.operation).toBeNull();
    // No PR lookup is attempted for a bare SHA.
    expect(status.pr).toBeNull();
  });

  it("returns an empty status outside a repository", async () => {
    const cwd = join(root, "not-a-repo");
    await Bun.write(join(cwd, "file.txt"), "hi\n");
    const status = await collectGitStatus(cwd);

    expect(status.branch).toBeNull();
    expect(status.operation).toBeNull();
    expect(status.dirty.total).toBe(0);
  });
});
