/**
 * Skills Extension — Server-Side
 *
 * Manages ~/.claude/skills as a neutral target directory: our skills live in
 * the skills repo and are symlinked in, third-party tools install their own
 * directories, and Claude Code syncs claude.ai skills into `synced/`.
 *
 * Stateless: every method re-derives the inventory from the filesystem and
 * ~/.claude/settings.json. Projects come from the session extension's
 * workspace registry.
 *
 * Local commands (`anima skills run|task|commands|help`) live in ./cli.ts.
 */

import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";
import {
  buildInventory,
  projectRootsFromWorkspaces,
  SKILL_VISIBILITIES,
  type SkillInventory,
  type SkillVisibility,
} from "./inventory";
import { linkSkill, unlinkSkill } from "./placement";
import { readSkillOverrides, setSkillVisibility } from "./settings";

export interface SkillsConfig {
  /** The skills repo. `~` is expanded. */
  repoPath?: string;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function createSkillsExtension(config: SkillsConfig = {}): AnimaExtension {
  let ctx: ExtensionContext | null = null;
  // Resolved in start(), never at import, so tests cannot reach live state.
  let home = "";
  let repoPath: string | null = null;

  const settingsPath = () => join(home, ".claude", "settings.json");

  function placementPaths(): { home: string; repoPath: string } {
    if (!repoPath) throw new Error("skills.repoPath is not configured in anima.json");
    return { home, repoPath };
  }

  async function listProjects(): Promise<string[]> {
    if (!ctx) return [];
    try {
      const result = (await ctx.call("session.list_workspaces", {})) as {
        workspaces?: Array<{ cwd?: string }>;
      };
      const cwds = (result.workspaces ?? []).map((w) => w.cwd).filter(Boolean) as string[];
      return projectRootsFromWorkspaces(cwds);
    } catch (err) {
      ctx.log.warn("Could not list workspaces; project placements omitted", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async function inventory(): Promise<SkillInventory> {
    return buildInventory({
      home,
      repoPath,
      projects: await listProjects(),
      overrides: readSkillOverrides(settingsPath()),
    });
  }

  return {
    id: "skills",
    name: "Skills",
    methods: [
      {
        name: "skills.health_check",
        description: "Return standardized health-check payload for the Skills extension",
        inputSchema: z.object({}),
      },
      {
        name: "skills.list_skills",
        description:
          "Inventory every skill: source (repo, third-party, synced, project), placements, and skillOverrides visibility, plus problems and skills-repo dirt",
        inputSchema: z.object({}),
      },
      {
        name: "skills.link",
        description:
          "Place a skills-repo skill globally (~/.claude/skills) or into one project; project links are hidden via the repo's local .git/info/exclude",
        inputSchema: z.object({
          skill: z.string().min(1).describe("Skill directory name in the skills repo"),
          project: z.string().optional().describe("Absolute project root; omit for global"),
        }),
      },
      {
        name: "skills.unlink",
        description:
          "Remove a placement of a skills-repo skill. Only removes our own symlinks; other skills are hidden with set_visibility",
        inputSchema: z.object({
          skill: z.string().min(1),
          project: z.string().optional().describe("Absolute project root; omit for global"),
        }),
      },
      {
        name: "skills.set_visibility",
        description:
          "Set a skill's skillOverrides entry in ~/.claude/settings.json (on removes the entry)",
        inputSchema: z.object({
          skill: z.string().min(1).describe("Skill name (frontmatter name)"),
          visibility: z.enum(SKILL_VISIBILITIES),
        }),
      },
    ],
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      home = homedir();
      repoPath = config.repoPath ? expandHome(config.repoPath, home) : null;
      ctx.log.info("Skills extension started", { repoPath });
    },

    async stop() {
      ctx?.log.info("Skills extension stopped");
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "skills.health_check": {
          const inv = await inventory();
          const linked = inv.skills.filter((s) => s.placements.length > 0).length;
          const response: HealthCheckResponse = {
            ok: true,
            status:
              inv.problems.length > 0 || (inv.repo?.dirty.length ?? 0) > 0 ? "degraded" : "healthy",
            label: "Skills",
            metrics: [
              { label: "Skills", value: String(inv.skills.length) },
              { label: "Placed", value: String(linked) },
              { label: "Problems", value: String(inv.problems.length) },
              { label: "Repo changes", value: String(inv.repo?.dirty.length ?? "no repo") },
            ],
          };
          return response;
        }

        case "skills.list_skills":
          return await inventory();

        case "skills.link": {
          const result = linkSkill(placementPaths(), {
            skill: params.skill as string,
            project: params.project as string | undefined,
          });
          ctx?.log.info("Linked skill", { ...result, skill: params.skill });
          return result;
        }

        case "skills.unlink": {
          const result = unlinkSkill(placementPaths(), {
            skill: params.skill as string,
            project: params.project as string | undefined,
          });
          ctx?.log.info("Unlinked skill", { ...result, skill: params.skill });
          return result;
        }

        case "skills.set_visibility": {
          const name = params.skill as string;
          const matches = (await inventory()).skills.filter((s) => s.name === name);
          if (matches.length === 0) throw new Error(`No skill named "${name}"`);
          if (matches.some((s) => s.source === "synced")) {
            // Unverified whether Claude Code keys synced skills as "docx" or
            // "anthropic-skills:docx"; a wrong key would fail silently.
            throw new Error(
              `"${name}" is a claude.ai synced skill; toggle it in claude.ai settings for now`,
            );
          }
          const change = setSkillVisibility(
            settingsPath(),
            name,
            params.visibility as SkillVisibility,
          );
          ctx?.log.info("Set skill visibility", { ...change });
          return change;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return { ok: true };
    },
  };
}

export default createSkillsExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createSkillsExtension);
