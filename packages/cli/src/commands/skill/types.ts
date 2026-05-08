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

/**
 * Skill commands resolve to one of two execution modes:
 *
 *   - `script`: a file inside the skill directory (e.g. "scripts/foo.js").
 *     Relative path. Runtime is detected by extension or shebang. Used when
 *     the command's logic lives with the skill.
 *
 *   - `command`: a binary on PATH (e.g. "eleven-tts"). Used when the command
 *     is shared tooling — the runner spawns the binary directly with the
 *     user's args, propagating SKILL_DIR / ANIMA_TASK_ID env vars. This avoids
 *     duplicating shared tools across skills.
 *
 * Exactly one of `script` or `command` must be set.
 */
export interface SkillCommandConfig {
  /** Path to a script inside the skill directory (relative). Mutually exclusive with `command`. */
  script?: string;
  /** Name of a binary on PATH. Mutually exclusive with `script`. */
  command?: string;
  /** Override runtime detection. Only used when `script` is set. */
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

/**
 * A command resolves to one of two execution modes — discriminated by `mode`:
 *
 *   - `mode: "script"` → spawn `runtime` with `scriptPath` as argv[0].
 *   - `mode: "command"` → spawn `commandBinary` directly. PATH-resolved.
 *
 * The runner uses the same env injection (SKILL_DIR / ANIMA_TASK_ID / etc.)
 * for both modes — only the binary lookup differs.
 */
export type ResolvedCommand =
  | {
      mode: "script";
      skillId: string;
      skillDir: string;
      command: string;
      scriptPath: string;
      runtime: SkillRuntime;
      config: SkillCommandConfig | null;
      longRunning: boolean;
      timeoutMs: number;
    }
  | {
      mode: "command";
      skillId: string;
      skillDir: string;
      command: string;
      /** Binary name (PATH-resolved at spawn time). */
      commandBinary: string;
      config: SkillCommandConfig;
      longRunning: boolean;
      timeoutMs: number;
    };

export interface SkillSummary {
  id: string;
  description?: string;
  /** Commands declared in skill.json (if any). */
  declaredCommands: string[];
  /** Commands found by convention under scripts/. */
  conventionCommands: string[];
}
