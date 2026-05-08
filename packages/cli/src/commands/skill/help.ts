/**
 * `anima skill help <skill-id> <command>` — show full help for a specific command.
 *
 * Help text is generated from skill.json when available; convention-resolved
 * commands get a minimal help showing their resolved script path.
 */

import { resolveCommand } from "./resolve.js";

export function runSkillHelp(args: string[]): void {
  const skillId = args[0];
  const command = args[1];

  if (!skillId || !command) {
    console.error("Usage: anima skill help <skill-id> <command>");
    process.exit(1);
  }

  const resolved = resolveCommand(skillId, command);

  console.log(`\n${skillId} ${command}`);
  if (resolved.config?.description) {
    console.log(`  ${resolved.config.description}`);
  }
  console.log("");

  if (resolved.mode === "command") {
    console.log(`  Binary:    ${resolved.commandBinary} (PATH-resolved)`);
  } else {
    console.log(`  Script:    ${resolved.scriptPath}`);
    console.log(`  Runtime:   ${resolved.runtime}`);
  }
  console.log(`  Long-run:  ${resolved.longRunning ? "yes (auto --task)" : "no"}`);
  console.log(`  Timeout:   ${(resolved.timeoutMs / 1000).toFixed(0)}s`);

  if (resolved.config?.env && resolved.config.env.length > 0) {
    console.log(`\n  Required env vars:`);
    for (const envVar of resolved.config.env) {
      const isSet = process.env[envVar] !== undefined;
      const flag = isSet ? "✓" : "✗ NOT SET";
      console.log(`    ${envVar.padEnd(30)} ${flag}`);
    }
  }

  if (resolved.config?.args && resolved.config.args.length > 0) {
    console.log(`\n  Arguments:`);
    for (const arg of resolved.config.args) {
      const required = arg.required ? "(required)" : "(optional)";
      const type = arg.type ? ` <${arg.type}>` : "";
      const desc = arg.description ? ` — ${arg.description}` : "";
      console.log(`    ${arg.name}${type} ${required}${desc}`);
    }
  }

  if (!resolved.config) {
    console.log(`\n  No skill.json entry — this command was resolved by convention.`);
    console.log(
      `  Add a commands.${command} entry to ${resolved.skillDir}/skill.json for richer help.`,
    );
  }

  console.log("\n  Invoke:");
  console.log(`    anima skill run ${skillId} ${command} <args...>`);
  if (resolved.longRunning) {
    console.log(
      `    anima skill run ${skillId} ${command} <args...> --sync   # override task mode`,
    );
  } else {
    console.log(
      `    anima skill run ${skillId} ${command} <args...> --task   # queue via scheduler`,
    );
  }
  console.log("");
}
