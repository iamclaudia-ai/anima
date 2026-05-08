/**
 * `anima skill run <skill-id> <command> [args...]` — run a skill command.
 *
 * Synchronous mode (default): exec'd inline, stdio inherited.
 * Task mode (--task or longRunning: true in skill.json): submitted to the
 * scheduler via scheduler.add_task with action.type = "exec". Returns task ID.
 *
 * Env injected for the script:
 *   SKILL_DIR        — absolute path to the skill directory
 *   SKILL_ID         — skill identifier
 *   SKILL_COMMAND    — command name
 *   ANIMA_TASK_ID    — only set in --task mode (the scheduler injects this)
 *   ANIMA_EXECUTION_ID — only set in --task mode (the scheduler injects this)
 *
 * The runner sets cwd to SKILL_DIR before exec — so legacy scripts using
 * relative paths still work.
 */

import { createGatewayClient } from "@anima/shared";
import { resolveCommand } from "./resolve.js";
import type { ResolvedCommand } from "./types.js";

export interface RunSkillOptions {
  skillId: string;
  command: string;
  scriptArgs: string[];
  /** Force task mode (queue via scheduler). */
  task?: boolean;
  /** Force inline mode even if longRunning is set. */
  sync?: boolean;
  /** Gateway URL for --task mode. */
  gatewayUrl?: string;
}

export async function runSkillCommand(opts: RunSkillOptions): Promise<number> {
  const resolved = resolveCommand(opts.skillId, opts.command);

  // Validate required env vars early (skill.json declarations only)
  if (resolved.config?.env) {
    const missing = resolved.config.env.filter((v) => process.env[v] === undefined);
    if (missing.length > 0) {
      console.error(`Error: missing required env var(s): ${missing.join(", ")}`);
      console.error(
        `  Declared in ${resolved.skillDir}/skill.json as commands.${opts.command}.env`,
      );
      return 1;
    }
  }

  // Resolve task mode: explicit --task wins, else longRunning auto-enables, --sync overrides
  const useTask = opts.task ?? (resolved.longRunning && !opts.sync);

  if (useTask) {
    return await submitAsTask(resolved, opts);
  } else {
    return await runInline(resolved, opts);
  }
}

// ── Inline (synchronous) execution ────────────────────────────────────

async function runInline(resolved: ResolvedCommand, opts: RunSkillOptions): Promise<number> {
  const { cmd, args } = buildSpawnArgs(resolved, opts.scriptArgs);

  const proc = Bun.spawn([cmd, ...args], {
    cwd: resolved.skillDir,
    env: {
      ...(process.env as Record<string, string>),
      SKILL_DIR: resolved.skillDir,
      SKILL_ID: resolved.skillId,
      SKILL_COMMAND: resolved.command,
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  // Race against per-command timeout
  const timeoutPromise = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), resolved.timeoutMs),
  );
  const exitPromise = proc.exited.then((code) => ({ code }));
  const result = await Promise.race([exitPromise, timeoutPromise]);

  if (result === "timeout") {
    proc.kill();
    console.error(
      `\nTimeout: ${resolved.skillId}/${resolved.command} exceeded ${resolved.timeoutMs}ms`,
    );
    return 124;
  }

  return result.code ?? 0;
}

// ── Task mode (submit to scheduler) ────────────────────────────────────

async function submitAsTask(resolved: ResolvedCommand, opts: RunSkillOptions): Promise<number> {
  if (!opts.gatewayUrl) {
    console.error("Error: --task mode requires gateway URL (this is a runner bug)");
    return 1;
  }

  const { cmd, args } = buildSpawnArgs(resolved, opts.scriptArgs);

  const client = createGatewayClient({ url: opts.gatewayUrl });

  try {
    const result = (await client.call("scheduler.add_task", {
      name: `skill:${resolved.skillId}:${resolved.command}`,
      description: resolved.config?.description,
      type: "once",
      delaySeconds: 0,
      action: {
        type: "exec",
        target: cmd,
        payload: {
          args,
          cwd: resolved.skillDir,
          timeoutMs: resolved.timeoutMs,
          env: {
            SKILL_DIR: resolved.skillDir,
            SKILL_ID: resolved.skillId,
            SKILL_COMMAND: resolved.command,
          },
        },
      },
      // skip_if_running prevents duplicate fires when a long task overlaps the 5s check loop
      concurrency: "skip_if_running",
      tags: ["skill", `skill:${resolved.skillId}`],
      keepHistory: 50,
    })) as { ok: boolean; taskId: string; name: string };

    console.log(`Task queued: ${result.taskId}`);
    console.log(`  Skill:   ${resolved.skillId}/${resolved.command}`);
    console.log(`  Status:  anima skill task ${result.taskId}`);
    console.log(`  Watch:   anima skill task ${result.taskId} --watch`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: failed to queue task — ${msg}`);
    return 1;
  } finally {
    client.disconnect();
  }
}

// ── Spawn argument builder ─────────────────────────────────────────────

interface SpawnArgs {
  cmd: string;
  args: string[];
}

/**
 * Build the (binary, args) tuple for spawning a resolved command.
 *
 * mode: "command" → [binary, userArgs]            (binary on PATH)
 * mode: "script":
 *   runtime=node     → ["node",     [scriptPath, ...userArgs]]
 *   runtime=bun      → ["bun",      [scriptPath, ...userArgs]]
 *   runtime=python3  → ["python3",  [scriptPath, ...userArgs]]
 *   runtime=bash     → ["bash",     [scriptPath, ...userArgs]]
 *   runtime=exec     → [scriptPath, [...userArgs]]
 */
function buildSpawnArgs(resolved: ResolvedCommand, userArgs: string[]): SpawnArgs {
  if (resolved.mode === "command") {
    return { cmd: resolved.commandBinary, args: userArgs };
  }
  if (resolved.runtime === "exec") {
    return { cmd: resolved.scriptPath, args: userArgs };
  }
  return { cmd: resolved.runtime, args: [resolved.scriptPath, ...userArgs] };
}
