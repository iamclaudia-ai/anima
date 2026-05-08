/**
 * Skill Runner — types for skill.json metadata.
 *
 * skill.json is OPTIONAL. When absent, the runner falls back to convention:
 * any executable file at scripts/<command>.{js,ts,py,sh} is callable, runtime
 * detected from extension/shebang, longRunning defaults to false.
 *
 * skill.json adds richer behavior: argv validation, longRunning declaration
 * (auto-enables --task mode), required env vars, descriptions for help text,
 * custom timeouts.
 */

export type SkillRuntime = "node" | "bun" | "python3" | "bash" | "exec";

export interface SkillCommandArg {
  /** Argument name (for documentation). */
  name: string;
  /** Type hint — informational only for now; future: enforce. */
  type?: "absolute-file" | "absolute-folder" | "string" | "number" | "boolean";
  /** Whether the argument must be provided. */
  required?: boolean;
  /** Help text shown in `anima skill help`. */
  description?: string;
}

export interface SkillCommandConfig {
  /** Path to script, relative to skill directory. */
  script: string;
  /** Override runtime detection. */
  runtime?: SkillRuntime;
  /** True → auto-enables --task mode (override with --sync). */
  longRunning?: boolean;
  /** Help text for `anima skill help`. */
  description?: string;
  /** Required positional/flag args (for help generation; validation in Phase 4+). */
  args?: SkillCommandArg[];
  /** Required env vars — runner errors fast if missing. */
  env?: string[];
  /** Per-command timeout (ms). Defaults to 600000 (10 min). */
  timeoutMs?: number;
}

export interface SkillJson {
  /** Skill identifier — should match the directory name. */
  id: string;
  /** Human-readable description for `anima skill list`. */
  description?: string;
  /** Map of command name → config. Convention-based commands also work without entries here. */
  commands?: Record<string, SkillCommandConfig>;
}

export interface ResolvedCommand {
  skillId: string;
  skillDir: string;
  command: string;
  /** Absolute path to the executable script. */
  scriptPath: string;
  runtime: SkillRuntime;
  /** Null if the command was resolved by convention (no skill.json entry). */
  config: SkillCommandConfig | null;
  longRunning: boolean;
  timeoutMs: number;
}

export interface SkillSummary {
  id: string;
  description?: string;
  /** Commands declared in skill.json (if any). */
  declaredCommands: string[];
  /** Commands found by convention under scripts/. */
  conventionCommands: string[];
}
