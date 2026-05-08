/**
 * File listing for the `@` file picker in the web UI.
 *
 * Strategy:
 *   - Inside a git repo: `git ls-files --cached --others --exclude-standard`
 *     gives us tracked + untracked files with full .gitignore respect, for free.
 *   - Outside git: recursive walk that skips heavy dirs (.git, node_modules, etc).
 *
 * Returns paths relative to `cwd`. The client caches per-cwd and filters with
 * fuzzysort on every keystroke, so we don't paginate or pre-filter on the server.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { relative, resolve } from "node:path";

export interface ListFilesParams {
  cwd: string;
}

export interface ListFilesResult {
  files: string[];
  source: "git" | "walk";
}

/** Directories to skip during the non-git fallback walk. */
const FALLBACK_IGNORES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
]);

/** Cap the fallback walk at this many files to avoid pathological scans. */
const FALLBACK_FILE_CAP = 50_000;

/**
 * Try `git ls-files`. Returns null if cwd isn't a git repo (or git isn't on PATH).
 */
function gitListFiles(cwd: string): string[] | null {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z", // null-delimited output → safe with weird filenames
    ],
    {
      cwd,
      encoding: "buffer",
      maxBuffer: 200 * 1024 * 1024, // 200MB; handles ~2M files comfortably
    },
  );

  if (result.status !== 0 || result.error) return null;

  const buf = result.stdout as Buffer;
  if (buf.length === 0) return [];

  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) out.push(buf.toString("utf8", start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.toString("utf8", start));
  return out;
}

/**
 * Recursive walk used when the workspace isn't a git repo. Skips well-known
 * heavy directories. Caps results so a misconfigured workspace can't OOM us.
 */
function fallbackWalk(cwd: string): string[] {
  const root = resolve(cwd);
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0 && out.length < FALLBACK_FILE_CAP) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (FALLBACK_IGNORES.has(entry.name)) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relative(root, full));
        if (out.length >= FALLBACK_FILE_CAP) break;
      }
    }
  }
  return out;
}

export function listFiles({ cwd }: ListFilesParams): ListFilesResult {
  const gitFiles = gitListFiles(cwd);
  if (gitFiles !== null) {
    return { files: gitFiles, source: "git" };
  }
  return { files: fallbackWalk(cwd), source: "walk" };
}
