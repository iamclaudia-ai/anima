/**
 * `anima skills <command>` — local commands for the skill runner.
 *
 * These run on the caller's machine, not the gateway: they execute that
 * machine's skills from ~/.claude/skills with the terminal's stdio and exit
 * code. `run --task` reaches the gateway only to queue work on the scheduler.
 *
 * The runner sets SKILL_DIR, SKILL_ID, SKILL_COMMAND env vars before exec.
 * Long-running commands (skill.json: longRunning: true) auto-enable --task.
 */

import type { ExtensionCli } from "@anima/shared";
import { runSkillCommand } from "./cli/run.js";
import { runSkillTask } from "./cli/task.js";
import { runSkillList } from "./cli/list.js";
import { runSkillHelp } from "./cli/help.js";

export const cli: ExtensionCli = {
  commands: {
    list: {
      description: "List skills with runnable commands, or one skill's commands",
      usage: "[skill-id]",
      async run(args) {
        runSkillList(args);
      },
    },

    help: {
      description: "Show help for one skill command",
      usage: "<skill-id> <command>",
      async run(args) {
        runSkillHelp(args);
      },
    },

    run: {
      description:
        "Run a skill command (inline unless longRunning; --task queues it, --sync forces inline)",
      usage: "<skill-id> <command> [args...] [--task | --sync]",
      async run(args, { gatewayUrl }) {
        const [skillId, command, ...rest] = args;
        if (!skillId || !command) {
          console.error("Usage: anima skills run <skill-id> <command> [args...] [--task | --sync]");
          return 1;
        }

        // --task / --sync belong to the runner; everything else reaches the script.
        const task = rest.includes("--task");
        const sync = rest.includes("--sync");
        if (task && sync) {
          console.error("Error: --task and --sync are mutually exclusive");
          return 1;
        }
        const scriptArgs = rest.filter((arg) => arg !== "--task" && arg !== "--sync");

        return await runSkillCommand({
          skillId,
          command,
          scriptArgs,
          task: task || undefined,
          sync: sync || undefined,
          gatewayUrl,
        });
      },
    },

    task: {
      description: "Show a queued skill task's status (--watch polls, --cancel stops it)",
      usage: "<task-id> [--watch | --cancel]",
      async run(args, { gatewayUrl }) {
        const taskId = args[0];
        if (!taskId) {
          console.error("Usage: anima skills task <task-id> [--watch | --cancel]");
          return 1;
        }
        const watch = args.includes("--watch");
        const cancel = args.includes("--cancel");
        if (watch && cancel) {
          console.error("Error: --watch and --cancel are mutually exclusive");
          return 1;
        }
        return await runSkillTask({ taskId, watch, cancel, gatewayUrl });
      },
    },
  },
};
