/**
 * Git status collector — runs at end-of-turn to populate the chat UI's
 * git status bar with the current branch, working-tree dirtiness, and any
 * open PR for the branch.
 *
 * All commands are spawned with a hard timeout and best-effort error
 * handling — a missing repo / missing `gh` / network failure should
 * return a partial result rather than throw.
 */

import { createLogger } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("SessionExt:GitStatus", join(homedir(), ".anima", "logs", "session.log"));

const GIT_TIMEOUT_MS = 1500;
const GH_TIMEOUT_MS = 4000;

/**
 * Common paths where `gh` and `git` live on macOS — prepended to PATH so
 * we find them even when the gateway is spawned by launchd/watchdog with
 * a stripped environment. Includes the user's dotfiles wrapper bin.
 */
const EXTRA_PATHS = [
  join(homedir(), "dotfiles", "scripts"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function buildPath(): string {
  // Prepend EXTRA_PATHS so the user's dotfiles wrapper (e.g. for `gh` auth
  // switching) wins over any system gh that might be earlier in PATH.
  const current = process.env.PATH ?? "";
  const segments: string[] = [];
  const seen = new Set<string>();
  for (const p of [...EXTRA_PATHS, ...current.split(":").filter(Boolean)]) {
    if (seen.has(p)) continue;
    seen.add(p);
    segments.push(p);
  }
  return segments.join(":");
}

export interface GitDirtyCounts {
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  renamed: number;
  total: number;
}

export interface GitPullRequest {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN, CLOSED, MERGED
  isDraft?: boolean;
}

export interface GitStatusResult {
  cwd: string;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: GitDirtyCounts;
  /**
   * `null` = confirmed no PR for branch.
   * `undefined` = lookup failed/skipped — caller should preserve any prior cached PR.
   */
  pr: GitPullRequest | null | undefined;
}

async function runCommand(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; ok: boolean; timedOut: boolean }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: buildPath(), GIT_OPTIONAL_LOCKS: "0" },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      ok: exitCode === 0,
      timedOut,
    };
  } catch {
    return { stdout: "", stderr: "", ok: false, timedOut: false };
  }
}

async function getBranch(cwd: string): Promise<string | null> {
  const { stdout, ok } = await runCommand(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
    GIT_TIMEOUT_MS,
  );
  if (!ok || !stdout || stdout === "HEAD") return null;
  return stdout;
}

async function getDirty(cwd: string): Promise<GitDirtyCounts> {
  const counts: GitDirtyCounts = {
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    renamed: 0,
    total: 0,
  };
  const { stdout, ok } = await runCommand(["git", "status", "--porcelain"], cwd, GIT_TIMEOUT_MS);
  if (!ok || !stdout) return counts;

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const status = line.slice(0, 2);
    counts.total += 1;
    if (status === "??") counts.untracked += 1;
    else if (status.includes("R")) counts.renamed += 1;
    else if (status.includes("A")) counts.added += 1;
    else if (status.includes("D")) counts.deleted += 1;
    else counts.modified += 1;
  }
  return counts;
}

async function getAheadBehind(cwd: string): Promise<{ ahead: number; behind: number }> {
  const { stdout, ok } = await runCommand(
    ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"],
    cwd,
    GIT_TIMEOUT_MS,
  );
  if (!ok || !stdout) return { ahead: 0, behind: 0 };
  const [behindStr, aheadStr] = stdout.split(/\s+/);
  return {
    ahead: Number.parseInt(aheadStr ?? "0", 10) || 0,
    behind: Number.parseInt(behindStr ?? "0", 10) || 0,
  };
}

async function getPullRequest(
  cwd: string,
  branch: string,
): Promise<GitPullRequest | null | undefined> {
  const cmd = [
    "gh",
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "1",
    "--json",
    "number,url,title,state,isDraft",
  ];
  log.info("gh pr list →", { cwd, branch, cmd: cmd.join(" ") });
  const { stdout, stderr, ok, timedOut } = await runCommand(cmd, cwd, GH_TIMEOUT_MS);
  log.info("gh pr list ←", {
    cwd,
    branch,
    ok,
    timedOut,
    stdoutLen: stdout.length,
    stdoutPreview: stdout.slice(0, 200),
    stderr: stderr.slice(0, 500),
  });
  if (!ok || timedOut) {
    log.warn("gh pr list failed — preserving prior cached PR", {
      cwd,
      branch,
      timedOut,
      stderr: stderr.slice(0, 500),
    });
    return undefined; // unknown — keep prior cache
  }
  if (!stdout) return null;
  // Defense-in-depth: gh wrappers (or future shims) may prepend status lines
  // to stdout. Extract the JSON payload by finding the first `[` or `{`.
  const jsonStart = stdout.search(/[[{]/);
  const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
  try {
    const arr = JSON.parse(jsonText) as Array<{
      number: number;
      url: string;
      title: string;
      state: string;
      isDraft?: boolean;
    }>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const data = arr[0];
    if (!data || !data.number || !data.url) return null;
    return {
      number: data.number,
      url: data.url,
      title: data.title,
      state: data.state,
      isDraft: data.isDraft,
    };
  } catch {
    return undefined;
  }
}

/** Collect git status for a workspace. Never throws. */
export async function collectGitStatus(cwd: string): Promise<GitStatusResult> {
  const branch = await getBranch(cwd);
  if (!branch) {
    return {
      cwd,
      branch: null,
      ahead: 0,
      behind: 0,
      dirty: { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0, total: 0 },
      pr: null,
    };
  }

  const [dirty, aheadBehind, pr] = await Promise.all([
    getDirty(cwd),
    getAheadBehind(cwd),
    getPullRequest(cwd, branch),
  ]);

  return {
    cwd,
    branch,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    dirty,
    pr,
  };
}
