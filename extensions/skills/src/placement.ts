/**
 * Placing repo skills into `.claude/skills` directories, and taking them out.
 *
 * Rules:
 * - Only skills from the skills repo are placed; we own those links and nothing else.
 * - `unlink` removes only symlinks that resolve into the repo. Third-party,
 *   synced, and project-owned skills are never moved or deleted (hide them with
 *   visibility instead).
 * - A project's `.claude/skills` may itself be a symlink (e.g. to a tracked
 *   `.agents/skills`). We write into the real directory and add that exact
 *   path to the repo's local `.git/info/exclude`, so the link is invisible to
 *   `git status` and can never be committed.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export interface PlacementTarget {
  /** Skill directory name in the repo. */
  skill: string;
  /** Project root; omitted for a global placement. */
  project?: string;
}

export interface PlacementPaths {
  /** Home directory (global target is `<home>/.claude/skills`). */
  home: string;
  /** The skills repo. */
  repoPath: string;
}

export interface LinkResult {
  /** The symlink, inside the real skills directory. */
  path: string;
  /** False when the link already existed. */
  created: boolean;
  /** The `.git/info/exclude` entry that hides it, for project placements in a git repo. */
  excluded: string | null;
}

export interface UnlinkResult {
  path: string;
  /** The `.git/info/exclude` entry removed, if any. */
  unexcluded: string | null;
}

const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXCLUDE_HEADER = "# anima skills: local skill links (managed by the skills extension)";

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

function validate(target: PlacementTarget): void {
  if (!SKILL_ID_RE.test(target.skill)) {
    throw new Error(`Invalid skill id: ${JSON.stringify(target.skill)}`);
  }
  if (target.project !== undefined) {
    if (!isAbsolute(target.project)) {
      throw new Error(`Project must be an absolute path: ${target.project}`);
    }
    if (!existsSync(target.project) || !lstatSync(realpathSync(target.project)).isDirectory()) {
      throw new Error(`Project directory not found: ${target.project}`);
    }
  }
}

/** The repo skill's real directory. Throws unless it is a skill in the repo. */
function repoSkillDir(paths: PlacementPaths, skill: string): string {
  const dir = join(realpathSync(paths.repoPath), skill);
  if (!existsSync(join(dir, "SKILL.md"))) {
    throw new Error(`"${skill}" is not a skill in the skills repo (${paths.repoPath})`);
  }
  return dir;
}

/**
 * The directory that actually receives the link. Follows a symlinked
 * `.claude/skills`; creates the directory when absent.
 */
function realSkillsDir(paths: PlacementPaths, project?: string): string {
  const logical = join(project ?? paths.home, ".claude", "skills");
  if (!existsSync(logical)) mkdirSync(logical, { recursive: true });
  return realpathSync(logical);
}

function git(cwd: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/** Repo toplevel and its exclude file, or null when `dir` is not in a git repo. */
function gitInfo(dir: string): { toplevel: string; excludeFile: string } | null {
  const toplevel = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return null;
  // --git-path resolves correctly from worktrees, whose `.git` is a file.
  const excludeFile = git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  if (!excludeFile) return null;
  return { toplevel: realpathSync(toplevel), excludeFile };
}

/** Exclude pattern for `entry` (anchored to the repo root), or null if it is outside the repo. */
function excludePattern(entry: string, toplevel: string): string | null {
  if (!isInside(entry, toplevel)) return null;
  return `/${relative(toplevel, entry).split(sep).join("/")}`;
}

/** File lines without trailing blank lines. */
function readLines(file: string): string[] {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

function writeLines(file: string, lines: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

/** Appends `pattern` under our header, leaving every existing line as it was. */
function addExclude(excludeFile: string, pattern: string): void {
  const lines = readLines(excludeFile);
  if (lines.includes(pattern)) return;
  if (!lines.includes(EXCLUDE_HEADER)) {
    if (lines.length > 0) lines.push("");
    lines.push(EXCLUDE_HEADER);
  }
  lines.push(pattern);
  writeLines(excludeFile, lines);
}

/** Removes `pattern`; drops our header too once nothing follows it. */
function removeExclude(excludeFile: string, pattern: string): boolean {
  const lines = readLines(excludeFile);
  if (!lines.includes(pattern)) return false;
  let kept = lines.filter((line) => line !== pattern);
  const header = kept.indexOf(EXCLUDE_HEADER);
  if (header !== -1 && kept.slice(header + 1).every((line) => line.trim() === "")) {
    kept = kept.slice(0, header);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  writeLines(excludeFile, kept);
  return true;
}

export function linkSkill(paths: PlacementPaths, target: PlacementTarget): LinkResult {
  validate(target);
  const source = repoSkillDir(paths, target.skill);
  const dir = realSkillsDir(paths, target.project);
  const entry = join(dir, target.skill);

  let created = false;
  if (existsSync(entry) || isBrokenLink(entry)) {
    const isOurLink = lstatSync(entry).isSymbolicLink() && safeRealpath(entry) === source;
    if (!isOurLink) {
      throw new Error(
        `${entry} already exists and is not a link to the repo skill; refusing to replace it`,
      );
    }
  } else {
    symlinkSync(source, entry);
    created = true;
  }

  let excluded: string | null = null;
  if (target.project) {
    const info = gitInfo(dir);
    const pattern = info ? excludePattern(entry, info.toplevel) : null;
    if (info && pattern) {
      addExclude(info.excludeFile, pattern);
      excluded = pattern;
    }
  }
  return { path: entry, created, excluded };
}

export function unlinkSkill(paths: PlacementPaths, target: PlacementTarget): UnlinkResult {
  validate(target);
  const repoReal = realpathSync(paths.repoPath);
  const logical = join(target.project ?? paths.home, ".claude", "skills");
  if (!existsSync(logical)) throw new Error(`No skills directory at ${logical}`);
  const dir = realpathSync(logical);
  const entry = join(dir, target.skill);

  if (!existsSync(entry) && !isBrokenLink(entry)) {
    throw new Error(`${target.skill} is not placed at ${logical}`);
  }
  if (!lstatSync(entry).isSymbolicLink()) {
    throw new Error(
      `${entry} is a real directory, not one of our links; hide it with set_visibility instead`,
    );
  }
  const real = safeRealpath(entry);
  if (real && !isInside(real, repoReal)) {
    throw new Error(
      `${entry} links outside the skills repo (${real}); hide it with set_visibility instead`,
    );
  }
  unlinkSync(entry);

  let unexcluded: string | null = null;
  if (target.project) {
    const info = gitInfo(dir);
    const pattern = info ? excludePattern(entry, info.toplevel) : null;
    if (info && pattern && removeExclude(info.excludeFile, pattern)) unexcluded = pattern;
  }
  return { path: entry, unexcluded };
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isBrokenLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && safeRealpath(path) === null;
  } catch {
    return false;
  }
}
