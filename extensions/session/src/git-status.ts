/**
 * Git status collector — runs at end-of-turn to populate the chat UI's
 * git status bar with the current branch, working-tree dirtiness, and any
 * open PR for the branch.
 *
 * All commands are spawned with a hard timeout and best-effort error
 * handling — a missing repo / missing `gh` / network failure should
 * return a partial result rather than throw.
 */

import { createLogger, truncatePreservingSurrogates } from "@anima/shared";
import { existsSync } from "node:fs";
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
  conflicted: number;
  total: number;
}

/** An in-progress git operation that leaves HEAD detached or the tree mid-merge. */
export type GitOperation = "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";

export interface GitPullRequest {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN, CLOSED, MERGED
  isDraft?: boolean;
}

export interface GitStatusResult {
  cwd: string;
  /**
   * The branch you'd say you were on. During a rebase HEAD is detached, so
   * this is the branch being replayed (read from the rebase state), not
   * `HEAD`. For a plain detached checkout it's the short SHA — see `detached`.
   */
  branch: string | null;
  /** `true` when `branch` is a bare SHA rather than a real ref name. */
  detached: boolean;
  /** In-progress operation, or `null` when the tree is at rest. */
  operation: GitOperation | null;
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

/** Absolute path to this worktree's git dir, or null outside a repo. */
async function getGitDir(cwd: string): Promise<string | null> {
  const { stdout, ok } = await runCommand(
    ["git", "rev-parse", "--absolute-git-dir"],
    cwd,
    GIT_TIMEOUT_MS,
  );
  return ok && stdout ? stdout : null;
}

async function readFirstLine(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return (await file.text()).split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Which operation, if any, the working tree is in the middle of.
 *
 * Read from the git dir rather than parsed out of porcelain: a rebase paused
 * on a conflict is indistinguishable from an ordinary dirty tree by status
 * output alone, and "you are mid-rebase" is the single most useful thing the
 * bar can say when it's true.
 */
function getOperation(gitDir: string | null): GitOperation | null {
  if (!gitDir) return null;
  // `existsSync`, not `Bun.file().exists()` — the rebase markers are
  // directories, and `Bun.file()` reports a directory as non-existent.
  //
  // `rebase-merge` is the modern/interactive rebase; `rebase-apply` backs the
  // am-based one (`git rebase --apply`, `git am`).
  if (existsSync(gitDir + "/rebase-merge") || existsSync(gitDir + "/rebase-apply")) return "rebase";
  if (existsSync(gitDir + "/MERGE_HEAD")) return "merge";
  if (existsSync(gitDir + "/CHERRY_PICK_HEAD")) return "cherry-pick";
  if (existsSync(gitDir + "/REVERT_HEAD")) return "revert";
  if (existsSync(gitDir + "/BISECT_LOG")) return "bisect";
  return null;
}

/**
 * Resolve the branch to display.
 *
 * `rev-parse --abbrev-ref HEAD` answers the literal string `HEAD` whenever
 * HEAD is detached — which a rebase always is, from the checkout of the base
 * until the last commit is replayed. Treating that as "no branch" blanked the
 * whole status bar for the length of every rebase, conflict counts included.
 * The rebase records the ref it came from, so ask it instead of giving up.
 */
async function getBranch(
  cwd: string,
  gitDir: string | null,
): Promise<{ branch: string | null; detached: boolean }> {
  const { stdout, ok } = await runCommand(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
    GIT_TIMEOUT_MS,
  );
  if (ok && stdout && stdout !== "HEAD") return { branch: stdout, detached: false };

  if (gitDir) {
    // Both rebase flavours record the original ref here, e.g. `refs/heads/feat`.
    const headName =
      (await readFirstLine(gitDir + "/rebase-merge/head-name")) ??
      (await readFirstLine(gitDir + "/rebase-apply/head-name"));
    if (headName) return { branch: headName.replace(/^refs\/heads\//, ""), detached: false };
  }

  // Genuinely detached — a bisect, or a bare checkout of a tag or SHA. A short
  // SHA is still worth more than an empty bar.
  const short = await runCommand(["git", "rev-parse", "--short", "HEAD"], cwd, GIT_TIMEOUT_MS);
  if (short.ok && short.stdout) return { branch: short.stdout, detached: true };

  return { branch: null, detached: false };
}

async function getDirty(cwd: string): Promise<GitDirtyCounts> {
  const counts: GitDirtyCounts = {
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    renamed: 0,
    conflicted: 0,
    total: 0,
  };
  const { stdout, ok } = await runCommand(["git", "status", "--porcelain"], cwd, GIT_TIMEOUT_MS);
  if (!ok || !stdout) return counts;

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const status = line.slice(0, 2);
    counts.total += 1;
    if (status === "??") counts.untracked += 1;
    // Unmerged paths, checked before the single-letter cases below because
    // `AA`/`DD`/`AU`/`UD` would otherwise be miscounted as plain adds/deletes.
    // A conflict is a different thing to be told about than an edit.
    else if (UNMERGED_CODES.has(status)) counts.conflicted += 1;
    // `status` is a 2-char string from line.slice(0, 2) — these are string
    // substring checks, not array lookups, so Set hoisting doesn't apply.
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    else if (status.includes("R")) counts.renamed += 1;
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    else if (status.includes("A")) counts.added += 1;
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    else if (status.includes("D")) counts.deleted += 1;
    else counts.modified += 1;
  }
  return counts;
}

/**
 * The porcelain v1 unmerged states. `git status --porcelain` reports a
 * conflicted path with one of these exact two-letter codes.
 */
const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

async function getAheadBehind(
  cwd: string,
  branch: string | null,
): Promise<{ ahead: number; behind: number }> {
  // Mid-rebase HEAD is detached, so bare `@{u}` has no upstream to resolve
  // against. Naming the branch we resolved keeps the counts alive through the
  // rebase; if it has no upstream the command just fails and we report 0/0.
  const upstream = branch ? `${branch}@{u}` : "@{u}";
  const { stdout, ok } = await runCommand(
    ["git", "rev-list", "--left-right", "--count", `${upstream}...HEAD`],
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
    stdoutPreview: truncatePreservingSurrogates(stdout, 200),
    stderr: truncatePreservingSurrogates(stderr, 500),
  });
  if (!ok || timedOut) {
    log.warn("gh pr list failed — preserving prior cached PR", {
      cwd,
      branch,
      timedOut,
      stderr: truncatePreservingSurrogates(stderr, 500),
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
  const gitDir = await getGitDir(cwd);
  const operation = getOperation(gitDir);
  const { branch, detached } = await getBranch(cwd, gitDir);

  // Only a path outside any repo has nothing to report. An unresolvable branch
  // used to short-circuit the whole collection, which meant a conflicted
  // working tree reported itself as clean.
  if (!gitDir) {
    return {
      cwd,
      branch: null,
      detached: false,
      operation: null,
      ahead: 0,
      behind: 0,
      dirty: {
        modified: 0,
        added: 0,
        deleted: 0,
        untracked: 0,
        renamed: 0,
        conflicted: 0,
        total: 0,
      },
      pr: null,
    };
  }

  const [dirty, aheadBehind, pr] = await Promise.all([
    getDirty(cwd),
    getAheadBehind(cwd, detached ? null : branch),
    // A bare SHA is not a head anyone opened a PR against — asking `gh` for one
    // spends four seconds to learn nothing.
    branch && !detached ? getPullRequest(cwd, branch) : Promise.resolve(null),
  ]);

  return {
    cwd,
    branch,
    detached,
    operation,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    dirty,
    pr,
  };
}
