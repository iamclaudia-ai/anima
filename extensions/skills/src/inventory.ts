/**
 * Skill inventory: where every skill lives, where it is placed, and whether
 * Claude Code shows it.
 *
 * Stateless by design. Everything is derived from the filesystem plus the
 * `skillOverrides` map on every call, so there is no stored state to drift.
 * All paths are explicit parameters; nothing here resolves `~` on its own.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** Who owns a skill's files. */
export type SkillSource =
  /** Ours: a directory in the skills repo. */
  | "repo"
  /** Installed by some other tool into ~/.claude/skills. */
  | "third-party"
  /** claude.ai account skills, written by Claude Code into ~/.claude/skills/synced. Read-only. */
  | "synced"
  /** Committed in (or installed into) a project's own .claude/skills. */
  | "project";

/** Claude Code's native `skillOverrides` values. A skill with no entry is "on". */
export const SKILL_VISIBILITIES = ["on", "name-only", "user-invocable-only", "off"] as const;
export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];

export interface SkillPlacement {
  scope: "global" | "project";
  /** Project root, for project placements. */
  project?: string;
  /** The entry inside a `.claude/skills` directory. */
  path: string;
  kind: "symlink" | "directory";
}

export interface SkillRecord {
  /** Directory name. */
  id: string;
  /** Frontmatter `name`, falling back to the directory name. */
  name: string;
  description: string;
  source: SkillSource;
  /** Real directory holding SKILL.md (symlinks resolved). */
  sourcePath: string;
  /** Every `.claude/skills` entry that resolves to this skill. Empty = available but not placed. */
  placements: SkillPlacement[];
  visibility: SkillVisibility;
}

export interface InventoryProblem {
  path: string;
  problem: string;
}

export interface SkillInventory {
  skills: SkillRecord[];
  problems: InventoryProblem[];
  /** Skills repo status; `dirty` lists `git status --porcelain` lines. */
  repo: { path: string; dirty: string[] } | null;
}

export interface InventoryOptions {
  /** Home directory; the global skills directory is `<home>/.claude/skills`. */
  home: string;
  /** The skills repo, or null if not configured. */
  repoPath: string | null;
  /** Project roots whose `.claude/skills` should be scanned. */
  projects: string[];
  /** `skillOverrides` from ~/.claude/settings.json. */
  overrides: Record<string, unknown>;
  /** Uncommitted changes in the repo. Injectable for tests; defaults to `git status`. */
  repoStatus?: (repoPath: string) => string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Reads `name` and `description` from SKILL.md frontmatter.
 *
 * Tries a real YAML parse first, which handles block scalars (`description: >`).
 * Falls back to a line-based read because Claude Code accepts frontmatter that
 * is not strictly valid YAML, such as an unquoted description containing ": ".
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};

  try {
    const data = Bun.YAML.parse(match[1]) as Record<string, unknown> | null;
    if (data && typeof data === "object") {
      return {
        name: typeof data.name === "string" ? data.name.trim() : undefined,
        description: typeof data.description === "string" ? data.description.trim() : undefined,
      };
    }
  } catch {
    // Not strict YAML; fall through to the lenient reader.
  }

  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (key !== "name" && key !== "description") continue;
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

function gitStatus(repoPath: string): string[] {
  const result = Bun.spawnSync(["git", "-C", repoPath, "status", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return [];
  return result.stdout.toString().split("\n").filter(Boolean);
}

export function buildInventory(options: InventoryOptions): SkillInventory {
  const records = new Map<string, SkillRecord>();
  const problems: InventoryProblem[] = [];
  const repoReal = options.repoPath ? tryRealpath(options.repoPath) : null;

  function visibilityFor(name: string): SkillVisibility {
    const value = options.overrides[name];
    return (SKILL_VISIBILITIES as readonly unknown[]).includes(value)
      ? (value as SkillVisibility)
      : "on";
  }

  function recordFor(realDir: string, source: SkillSource, id: string): SkillRecord {
    const existing = records.get(realDir);
    if (existing) return existing;
    const meta = parseSkillFrontmatter(readFileSync(join(realDir, "SKILL.md"), "utf8"));
    const name = meta.name || id;
    const record: SkillRecord = {
      id,
      name,
      description: meta.description ?? "",
      source,
      sourcePath: realDir,
      placements: [],
      visibility: visibilityFor(name),
    };
    records.set(realDir, record);
    return record;
  }

  // 1. Everything in the repo is available, whether or not it is linked anywhere.
  if (repoReal) {
    for (const id of listEntries(repoReal)) {
      const dir = join(repoReal, id);
      if (existsSync(join(dir, "SKILL.md"))) recordFor(dir, "repo", id);
    }
  }

  // 2. Each `.claude/skills` entry is a placement of some skill.
  function scanSkillsDir(dir: string, scope: "global" | "project", project?: string): void {
    for (const entry of listEntries(dir)) {
      const path = join(dir, entry);

      if (scope === "global" && entry === "synced") {
        scanSynced(path);
        continue;
      }

      const kind = lstatSync(path).isSymbolicLink() ? "symlink" : "directory";
      const real = tryRealpath(path);
      if (!real) {
        problems.push({ path, problem: "broken symlink" });
        continue;
      }
      if (!statSync(real).isDirectory()) continue;
      if (!existsSync(join(real, "SKILL.md"))) {
        problems.push({ path, problem: "no SKILL.md" });
        continue;
      }

      const source: SkillSource =
        repoReal && isInside(real, repoReal)
          ? "repo"
          : scope === "global"
            ? "third-party"
            : "project";
      recordFor(real, source, entry).placements.push({ scope, project, path, kind });
    }
  }

  function scanSynced(syncedDir: string): void {
    for (const bucket of listEntries(syncedDir)) {
      for (const id of listEntries(join(syncedDir, bucket))) {
        const dir = join(syncedDir, bucket, id);
        if (!existsSync(join(dir, "SKILL.md"))) continue;
        recordFor(dir, "synced", id).placements.push({
          scope: "global",
          path: dir,
          kind: "directory",
        });
      }
    }
  }

  scanSkillsDir(join(options.home, ".claude", "skills"), "global");
  for (const project of options.projects) {
    scanSkillsDir(join(project, ".claude", "skills"), "project", project);
  }

  // 3. Name clashes Claude Code can actually see together: two global skills with
  //    one name, or a project skill shadowing a global one. Two projects (or a repo
  //    and its worktree) sharing a name never load in the same session, so they
  //    are not reported.
  const globalByName = new Map<string, SkillRecord[]>();
  for (const record of records.values()) {
    if (record.placements.some((p) => p.scope === "global")) {
      globalByName.set(record.name, [...(globalByName.get(record.name) ?? []), record]);
    }
  }
  for (const [name, globals] of globalByName) {
    if (globals.length > 1) {
      problems.push({
        path: globals.map((r) => r.sourcePath).join(", "),
        problem: `${globals.length} global skills are named "${name}"`,
      });
    }
  }
  for (const record of records.values()) {
    const globals = globalByName.get(record.name) ?? [];
    for (const placement of record.placements) {
      if (placement.scope !== "project" || globals.every((g) => g === record)) continue;
      problems.push({
        path: placement.path,
        problem: `shadows the global skill "${record.name}" in ${placement.project}`,
      });
    }
  }

  const skills = [...records.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath),
  );
  const repo = repoReal
    ? { path: repoReal, dirty: (options.repoStatus ?? gitStatus)(repoReal) }
    : null;
  return { skills, problems, repo };
}

/** Project roots from workspace cwds: existing directories, scratch dirs skipped, deduped. */
export function projectRootsFromWorkspaces(cwds: string[]): string[] {
  const roots = new Set<string>();
  for (const cwd of cwds) {
    if (cwd.startsWith("/private/tmp/") || cwd.startsWith("/tmp/")) continue;
    const real = tryRealpath(cwd);
    if (real && statSync(real).isDirectory()) roots.add(real);
  }
  return [...roots].sort();
}
