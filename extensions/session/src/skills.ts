/**
 * Compatibility re-export for Anthropic provider skill discovery.
 */

export {
  formatSkillsForPrompt,
  loadSkills,
} from "../../../packages/agent-host/src/providers/anthropic/skills";

export type {
  LoadSkillsOptions,
  Skill,
} from "../../../packages/agent-host/src/providers/anthropic/skills";
