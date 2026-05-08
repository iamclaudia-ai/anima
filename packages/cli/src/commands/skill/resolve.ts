/**
 * Skill resolution — turn `<skill-id> <command>` into a runnable script.
 *
 * Resolution order:
 *   1. Look for skill.json → commands.<command>.script
 *   2. Fall back to convention: scripts/<command>.{js,ts,mjs,mts,py,sh}
 *
 * Skills live at ~/.claude/skills/<skill-id>/. The runner never assumes CWD.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ResolvedCommand, SkillJson, SkillRuntime, SkillSummary } from "./types.js";

export const SKILLS_ROOT = join(homedir(), ".claude", "skills");

const CONVENTION_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".py", ".sh", ""] as const;

/**
 * Resolve a skill ID to its directory. Throws if not found.
 */
export function resolveSkillDir(skillId: string): string {
  const dir = join(SKILLS_ROOT, skillId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Skill not found: ${skillId}\n  (looked in ${dir})`);
  }
  return dir;
}

/**
 * Load skill.json from a skill directory. Returns null if absent.
 * Throws if present but malformed.
 */
export function loadSkillJson(skillDir: string): SkillJson | null {
  const path = join(skillDir, "skill.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as SkillJson;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse skill.json at ${path}: ${msg}`);
  }
}

/**
 * Detect script runtime from extension, with shebang fallback for extensionless files.
 */
export function detectRuntime(scriptPath: string): SkillRuntime {
  if (scriptPath.endsWith(".ts") || scriptPath.endsWith(".mts")) return "bun";
  if (scriptPath.endsWith(".js") || scriptPath.endsWith(".mjs")) return "node";
  if (scriptPath.endsWith(".py")) return "python3";
  if (scriptPath.endsWith(".sh")) return "bash";

  // Extensionless — sniff shebang
  if (existsSync(scriptPath)) {
    try {
      const head = readFileSync(scriptPath, "utf8").slice(0, 200);
      if (/^#!.*\bbun\b/.test(head)) return "bun";
      if (/^#!.*\bnode\b/.test(head)) return "node";
      if (/^#!.*\bpython3?\b/.test(head)) return "python3";
      if (/^#!.*\bbash\b/.test(head)) return "bash";
      if (/^#!/.test(head)) return "exec";
    } catch {
      // ignore — fall through
    }
  }
  return "exec";
}

/**
 * Resolve a (skill-id, command) pair to a ResolvedCommand.
 * Checks skill.json first, then falls back to convention.
 */
export function resolveCommand(skillId: string, command: string): ResolvedCommand {
  const skillDir = resolveSkillDir(skillId);
  const skillJson = loadSkillJson(skillDir);

  // 1. skill.json declaration takes priority
  const declared = skillJson?.commands?.[command];
  if (declared) {
    const scriptPath = join(skillDir, declared.script);
    if (!existsSync(scriptPath)) {
      throw new Error(
        `Script not found: ${scriptPath}\n  (declared in ${join(skillDir, "skill.json")} as commands.${command}.script)`,
      );
    }
    return {
      skillId,
      skillDir,
      command,
      scriptPath,
      runtime: declared.runtime ?? detectRuntime(scriptPath),
      config: declared,
      longRunning: declared.longRunning ?? false,
      timeoutMs: declared.timeoutMs ?? 600_000,
    };
  }

  // 2. Convention fallback: scripts/<command>.<ext>
  for (const ext of CONVENTION_EXTENSIONS) {
    const scriptPath = join(skillDir, "scripts", `${command}${ext}`);
    if (existsSync(scriptPath) && statSync(scriptPath).isFile()) {
      return {
        skillId,
        skillDir,
        command,
        scriptPath,
        runtime: detectRuntime(scriptPath),
        config: null,
        longRunning: false,
        timeoutMs: 600_000,
      };
    }
  }

  const candidates = CONVENTION_EXTENSIONS.map((e) => `scripts/${command}${e}`).join(", ");
  throw new Error(
    `Command not found: ${skillId}/${command}\n` +
      `  Looked in skill.json (no commands.${command} entry) and by convention (${candidates}).`,
  );
}

/**
 * List all skills under SKILLS_ROOT. Skips hidden dirs and dirs starting with `_`.
 */
export function listSkills(): SkillSummary[] {
  if (!existsSync(SKILLS_ROOT)) return [];

  const entries = readdirSync(SKILLS_ROOT, { withFileTypes: true });
  const summaries: SkillSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

    const skillDir = join(SKILLS_ROOT, entry.name);
    let skillJson: SkillJson | null = null;
    try {
      skillJson = loadSkillJson(skillDir);
    } catch {
      // Skip skills with broken skill.json; user can still run them via convention.
    }

    const declaredCommands = skillJson?.commands ? Object.keys(skillJson.commands) : [];

    const conventionCommands: string[] = [];
    const scriptsDir = join(skillDir, "scripts");
    if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
      for (const file of readdirSync(scriptsDir)) {
        const filePath = join(scriptsDir, file);
        if (!statSync(filePath).isFile()) continue;
        // Strip extension to get command name
        const dotIdx = file.lastIndexOf(".");
        const cmdName = dotIdx > 0 ? file.slice(0, dotIdx) : file;
        // Skip if already declared (declared takes precedence in resolution)
        if (!declaredCommands.includes(cmdName) && !conventionCommands.includes(cmdName)) {
          conventionCommands.push(cmdName);
        }
      }
    }

    // Only surface skills that have at least one runnable command
    if (declaredCommands.length === 0 && conventionCommands.length === 0) continue;

    summaries.push({
      id: entry.name,
      description: skillJson?.description,
      declaredCommands,
      conventionCommands,
    });
  }

  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return summaries;
}
