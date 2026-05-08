/**
 * `anima skill <subcommand>` — entry point for the skill runner.
 *
 * Subcommands:
 *   anima skill run <skill-id> <command> [args...] [--task] [--sync]
 *   anima skill task <task-id> [--watch] [--cancel]
 *   anima skill list [skill-id]
 *   anima skill help <skill-id> <command>
 *
 * The runner sets SKILL_DIR, SKILL_ID, SKILL_COMMAND env vars before exec.
 * Long-running commands (skill.json: longRunning: true) auto-enable --task.
 * Pass --sync to override.
 */

import { runSkillCommand } from "./run.js";
import { runSkillTask } from "./task.js";
import { runSkillList } from "./list.js";
import { runSkillHelp } from "./help.js";

export async function skillCommand(args: string[], gatewayUrl: string): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || (sub === "help" && args.length === 1)) {
    printSkillHelp();
    return;
  }

  if (sub === "list") {
    runSkillList(args.slice(1));
    return;
  }

  if (sub === "help") {
    runSkillHelp(args.slice(1));
    return;
  }

  if (sub === "run") {
    const exitCode = await handleRun(args.slice(1), gatewayUrl);
    process.exit(exitCode);
  }

  if (sub === "task") {
    const exitCode = await handleTask(args.slice(1), gatewayUrl);
    process.exit(exitCode);
  }

  console.error(`Unknown skill subcommand: ${sub}`);
  printSkillHelp();
  process.exit(1);
}

async function handleRun(args: string[], gatewayUrl: string): Promise<number> {
  const skillId = args[0];
  const command = args[1];

  if (!skillId || !command) {
    console.error("Usage: anima skill run <skill-id> <command> [args...] [--task | --sync]");
    return 1;
  }

  // Split out --task / --sync from the rest of args so they don't reach the script
  const rest = args.slice(2);
  let task = false;
  let sync = false;
  const scriptArgs: string[] = [];

  for (const arg of rest) {
    if (arg === "--task") task = true;
    else if (arg === "--sync") sync = true;
    else scriptArgs.push(arg);
  }

  if (task && sync) {
    console.error("Error: --task and --sync are mutually exclusive");
    return 1;
  }

  return await runSkillCommand({
    skillId,
    command,
    scriptArgs,
    task: task || undefined,
    sync: sync || undefined,
    gatewayUrl,
  });
}

async function handleTask(args: string[], gatewayUrl: string): Promise<number> {
  const taskId = args[0];

  if (!taskId) {
    console.error("Usage: anima skill task <task-id> [--watch | --cancel]");
    return 1;
  }

  const watch = args.includes("--watch");
  const cancel = args.includes("--cancel");

  if (watch && cancel) {
    console.error("Error: --watch and --cancel are mutually exclusive");
    return 1;
  }

  return await runSkillTask({
    taskId,
    watch,
    cancel,
    gatewayUrl,
  });
}

function printSkillHelp(): void {
  console.log(`
anima skill — run skill scripts as installed binaries

Subcommands:

  list [skill-id]                     List skills with runnable commands
  help <skill-id> <command>           Show help for a specific command
  run <skill-id> <command> [args...]  Run a command (synchronous unless longRunning)
       [--task]                         Force task mode (queue via scheduler)
       [--sync]                         Force inline mode (override longRunning)
  task <task-id>                      Show status of a queued task
       [--watch]                        Poll until completion
       [--cancel]                       Cancel a queued/running task

Env injected for scripts:
  SKILL_DIR              Absolute path to the skill directory
  SKILL_ID               Skill identifier
  SKILL_COMMAND          Command name
  ANIMA_TASK_ID          (--task mode only) — for progress reporting
  ANIMA_EXECUTION_ID     (--task mode only)

Examples:

  anima skill list
  anima skill help writing-romance-novels generate-audio
  anima skill run writing-romance-novels generate-cover /path/to/novel-folder
  anima skill run writing-romance-novels generate-audio /path/to/chapter-1.md
  anima skill task task_abc123 --watch
`);
}
