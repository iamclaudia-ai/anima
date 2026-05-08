/**
 * `anima skill list` — discover available skills and their commands.
 *
 *   anima skill list                    → all skills with at least one command
 *   anima skill list <skill-id>         → that skill's commands with descriptions
 */

import { listSkills, loadSkillJson, resolveSkillDir } from "./resolve.js";

export function runSkillList(args: string[]): void {
  const skillId = args[0];

  if (!skillId) {
    listAllSkills();
    return;
  }

  listOneSkill(skillId);
}

function listAllSkills(): void {
  const skills = listSkills();
  if (skills.length === 0) {
    console.log("No skills with runnable commands found in ~/.claude/skills/");
    return;
  }

  console.log(`\nSkills (${skills.length}) — use \`anima skill list <skill-id>\` for details\n`);

  // Compute padding
  const idWidth = Math.max(...skills.map((s) => s.id.length), 10);

  for (const skill of skills) {
    const totalCmds = skill.declaredCommands.length + skill.conventionCommands.length;
    const cmdLabel = `${totalCmds} command${totalCmds === 1 ? "" : "s"}`;
    const desc = skill.description ? `  ${skill.description}` : "";
    console.log(`  ${skill.id.padEnd(idWidth)}  ${cmdLabel.padEnd(12)}${desc}`);
  }
  console.log("");
}

function listOneSkill(skillId: string): void {
  const skillDir = resolveSkillDir(skillId);
  const skillJson = loadSkillJson(skillDir);
  const skills = listSkills();
  const summary = skills.find((s) => s.id === skillId);

  if (!summary) {
    throw new Error(
      `No runnable commands found for skill: ${skillId}\n` +
        `  (looked in ${skillDir}/skill.json and ${skillDir}/scripts/)`,
    );
  }

  console.log(`\n${skillId}`);
  if (skillJson?.description) {
    console.log(`  ${skillJson.description}`);
  }
  console.log("");

  if (summary.declaredCommands.length > 0) {
    console.log("  Declared commands (skill.json):");
    const cmdWidth = Math.max(...summary.declaredCommands.map((c) => c.length), 10);
    for (const cmd of summary.declaredCommands) {
      const cfg = skillJson?.commands?.[cmd];
      const flags: string[] = [];
      if (cfg?.longRunning) flags.push("longRunning");
      const flagStr = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
      const desc = cfg?.description ? `  ${cfg.description}` : "";
      console.log(`    ${cmd.padEnd(cmdWidth)}${flagStr}${desc}`);
    }
    console.log("");
  }

  if (summary.conventionCommands.length > 0) {
    console.log("  Convention commands (scripts/):");
    for (const cmd of summary.conventionCommands) {
      console.log(`    ${cmd}`);
    }
    console.log("");
  }

  console.log(`  Run:  anima skill run ${skillId} <command> [args...]`);
  console.log(`  Help: anima skill help ${skillId} <command>`);
  console.log("");
}
