/**
 * Skills + slash command discovery for the `/` picker in the web UI.
 *
 * Scans four locations on disk and returns a flat, deduped list:
 *   1. ~/.claude/skills/<name>/SKILL.md         (global skills)
 *   2. ~/.claude/commands/<name>.md             (global commands)
 *   3. <cwd>/.claude/skills/<name>/SKILL.md     (project skills, if cwd given)
 *   4. <cwd>/.claude/commands/<name>.md         (project commands)
 *
 * Project entries shadow global entries on name collision. Results are cached
 * in-memory keyed by cwd, with mtime-based invalidation so we don't re-scan
 * on every keystroke.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface CommandItem {
  name: string;
  description: string;
  source: "global" | "project";
}

interface CacheEntry {
  items: CommandItem[];
  fingerprint: string;
}

const cache = new Map<string, CacheEntry>();

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse YAML-ish frontmatter. Supports `key: value` and `key: "value"` —
 * enough for SKILL.md and command .md files. Multi-line values, lists, and
 * nested objects are ignored (we don't need them for picker metadata).
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    // `line.indexOf(":")` is a string method, not an array search — Set/Map
    // lookups don't apply here.
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip wrapping quotes
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

function tryStat(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function tryReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function scanSkillsDir(skillsDir: string, source: CommandItem["source"]): CommandItem[] {
  const items: CommandItem[] = [];
  for (const entry of tryReaddir(skillsDir)) {
    const skillFile = join(skillsDir, entry, "SKILL.md");
    const content = tryReadFile(skillFile);
    if (!content) continue;
    const fm = parseFrontmatter(content);
    items.push({
      name: fm.name || entry,
      description: fm.description || "",
      source,
    });
  }
  return items;
}

function scanCommandsDir(commandsDir: string, source: CommandItem["source"]): CommandItem[] {
  const items: CommandItem[] = [];
  for (const entry of tryReaddir(commandsDir)) {
    if (!entry.endsWith(".md")) continue;
    const file = join(commandsDir, entry);
    const content = tryReadFile(file);
    if (!content) continue;
    const fm = parseFrontmatter(content);
    items.push({
      name: basename(entry, ".md"),
      description: fm.description || "",
      source,
    });
  }
  return items;
}

/**
 * Build a cheap fingerprint from the mtimes of the four roots. If none of them
 * have changed since the cached scan, we can return the cached items as-is.
 */
function buildFingerprint(roots: string[]): string {
  return roots
    .map((root) => {
      const stat = tryStat(root);
      return stat ? `${root}:${stat.mtimeMs}` : `${root}:none`;
    })
    .join("|");
}

export interface ListCommandsParams {
  cwd?: string;
  /** Override home directory (test hook). Defaults to `os.homedir()`. */
  home?: string;
}

export interface ListCommandsResult {
  items: CommandItem[];
}

export function listCommands({ cwd, home }: ListCommandsParams = {}): ListCommandsResult {
  const homeDir = home ?? homedir();
  const globalSkills = join(homeDir, ".claude", "skills");
  const globalCommands = join(homeDir, ".claude", "commands");
  const projectSkills = cwd ? join(cwd, ".claude", "skills") : null;
  const projectCommands = cwd ? join(cwd, ".claude", "commands") : null;

  const roots = [globalSkills, globalCommands];
  if (projectSkills) roots.push(projectSkills);
  if (projectCommands) roots.push(projectCommands);

  const cacheKey = cwd || "<global>";
  const fingerprint = buildFingerprint(roots);
  const cached = cache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) {
    return { items: cached.items };
  }

  // Project entries shadow global entries on name collision: build a name → item
  // map, inserting global first, then project.
  const byName = new Map<string, CommandItem>();
  for (const item of scanSkillsDir(globalSkills, "global")) byName.set(item.name, item);
  for (const item of scanCommandsDir(globalCommands, "global")) byName.set(item.name, item);
  if (projectSkills) {
    for (const item of scanSkillsDir(projectSkills, "project")) byName.set(item.name, item);
  }
  if (projectCommands) {
    for (const item of scanCommandsDir(projectCommands, "project")) byName.set(item.name, item);
  }

  const items = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  cache.set(cacheKey, { items, fingerprint });
  return { items };
}

/** Test helper — wipes the in-memory cache so each test starts fresh. */
export function clearCommandsCache(): void {
  cache.clear();
}
