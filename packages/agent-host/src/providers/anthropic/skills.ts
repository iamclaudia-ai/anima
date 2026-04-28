import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "global" | "project" | "config";
  disableModelInvocation: boolean;
}

export interface LoadSkillsOptions {
  cwd?: string;
  additionalPaths?: string[];
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

const SKILL_MD_NAME = "SKILL.md";

function getHomeDir(): string {
  return process.env.ANIMA_HOME || homedir();
}

function normalizePath(input: string): string {
  const home = getHomeDir();
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

function resolvePath(p: string, cwd: string): string {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findProjectSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const gitRoot = findGitRoot(cwd);

  let dir = resolve(cwd);
  while (true) {
    dirs.push(join(dir, ".anima", "skills"));
    dirs.push(join(dir, ".agents", "skills"));

    if (gitRoot && dir === gitRoot) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirs;
}

function parseFrontmatter(rawContent: string): SkillFrontmatter {
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const frontmatter: SkillFrontmatter = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    let value: unknown = rawValue;

    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      value = rawValue.slice(1, -1);
    } else if (rawValue === "true") {
      value = true;
    } else if (rawValue === "false") {
      value = false;
    }

    frontmatter[key] = value;
  }

  return frontmatter;
}

function loadSkillFromFile(
  filePath: string,
  source: "global" | "project" | "config",
): Skill | null {
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const frontmatter = parseFrontmatter(rawContent);
    const description = String(frontmatter.description || "").trim();
    if (!description) return null;

    const baseDir = dirname(filePath);
    const defaultName = basename(baseDir);
    const name = String(frontmatter.name || defaultName).trim();
    if (!name) return null;

    return {
      name,
      description,
      filePath,
      baseDir,
      source,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
  } catch {
    return null;
  }
}

function loadSkillsFromDir(
  dir: string,
  source: "global" | "project" | "config",
  includeRootFiles: boolean,
): Skill[] {
  const skills: Skill[] = [];
  if (!existsSync(dir)) return skills;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        skills.push(...loadSkillsFromDir(fullPath, source, false));
        continue;
      }

      if (!isFile) continue;

      const isRootMd = includeRootFiles && entry.name.endsWith(".md");
      const isSkillMd = !includeRootFiles && entry.name === SKILL_MD_NAME;
      if (!isRootMd && !isSkillMd) continue;

      const skill = loadSkillFromFile(fullPath, source);
      if (skill) skills.push(skill);
    }
  } catch {
    // Ignore unreadable directories.
  }

  return skills;
}

function addUniquePath(pathSet: Set<string>, input: string): boolean {
  const normalized = resolve(input);
  let canonical = normalized;
  try {
    canonical = realpathSync(normalized);
  } catch {
    // Path may not exist or be inaccessible.
  }
  if (pathSet.has(canonical)) return false;
  pathSet.add(canonical);
  return true;
}

export function loadSkills(options: LoadSkillsOptions = {}): Skill[] {
  const cwd = resolvePath(options.cwd || process.cwd(), process.cwd());
  const additionalPaths = options.additionalPaths || [];
  const home = getHomeDir();
  const discoveredDirs: Array<{ dir: string; source: "global" | "project" }> = [
    { dir: join(home, ".anima", "skills"), source: "global" },
    { dir: join(home, ".claude", "skills"), source: "global" },
    { dir: join(home, ".agents", "skills"), source: "global" },
    ...findProjectSkillDirs(cwd).map((dir) => ({ dir, source: "project" as const })),
  ];

  const filePathSet = new Set<string>();
  const skillNameMap = new Map<string, Skill>();

  for (const { dir, source } of discoveredDirs) {
    for (const skill of loadSkillsFromDir(dir, source, true)) {
      if (!addUniquePath(filePathSet, skill.filePath)) continue;
      if (skillNameMap.has(skill.name)) continue;
      skillNameMap.set(skill.name, skill);
    }
  }

  for (const rawPath of additionalPaths) {
    const resolvedPath = resolvePath(rawPath, cwd);
    if (!existsSync(resolvedPath)) continue;

    try {
      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) {
        for (const skill of loadSkillsFromDir(resolvedPath, "config", true)) {
          if (!addUniquePath(filePathSet, skill.filePath)) continue;
          if (skillNameMap.has(skill.name)) continue;
          skillNameMap.set(skill.name, skill);
        }
      } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
        const skill = loadSkillFromFile(resolvedPath, "config");
        if (!skill) continue;
        if (!addUniquePath(filePathSet, skill.filePath)) continue;
        if (skillNameMap.has(skill.name)) continue;
        skillNameMap.set(skill.name, skill);
      }
    } catch {
      // Ignore unreadable additional paths.
    }
  }

  return Array.from(skillNameMap.values());
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (the parent directory of SKILL.md).",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}
