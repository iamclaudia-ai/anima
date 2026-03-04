import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatSkillsForPrompt, loadSkills } from "./skills";

describe("skills", () => {
  it("loads global and project skills with expected discovery rules", () => {
    const tempHome = join(tmpdir(), `claudia-skills-test-${Date.now()}`);
    const previousClaudiaHome = process.env.CLAUDIA_HOME;
    const cwd = join(tempHome, "repo", "apps", "chat");

    try {
      process.env.CLAUDIA_HOME = tempHome;

      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(tempHome, ".claudia", "skills"), { recursive: true });
      mkdirSync(join(tempHome, ".claude", "skills"), { recursive: true });
      mkdirSync(join(tempHome, "repo", ".claudia", "skills", "repo-skill"), { recursive: true });
      mkdirSync(join(tempHome, "repo", "apps", ".agents", "skills"), { recursive: true });

      writeFileSync(
        join(tempHome, ".claudia", "skills", "global.md"),
        [
          "---",
          "name: global-skill",
          "description: A global helper skill.",
          "---",
          "",
          "# Global",
        ].join("\n"),
      );
      writeFileSync(
        join(tempHome, ".claude", "skills", "claude-global.md"),
        [
          "---",
          "name: claude-global-skill",
          "description: A Claude global helper skill.",
          "---",
          "",
          "# Claude Global",
        ].join("\n"),
      );
      writeFileSync(
        join(tempHome, "repo", ".claudia", "skills", "repo-skill", "SKILL.md"),
        ["---", "name: repo-skill", "description: A repo helper skill.", "---", "", "# Repo"].join(
          "\n",
        ),
      );
      writeFileSync(
        join(tempHome, "repo", "apps", ".agents", "skills", "hidden.md"),
        [
          "---",
          "name: hidden-skill",
          "description: Hidden helper.",
          "disable-model-invocation: true",
          "---",
          "",
          "# Hidden",
        ].join("\n"),
      );
      writeFileSync(
        join(tempHome, "repo", "apps", ".agents", "skills", "missing-description.md"),
        ["---", "name: skipped-skill", "---", "", "# Skipped"].join("\n"),
      );

      const skills = loadSkills({ cwd });

      const names = skills.map((s) => s.name);
      expect(names.includes("global-skill")).toBe(true);
      expect(names.includes("claude-global-skill")).toBe(true);
      expect(names.includes("hidden-skill")).toBe(true);
      expect(names.includes("repo-skill")).toBe(true);
      expect(skills.find((s) => s.name === "hidden-skill")?.disableModelInvocation).toBe(true);
      expect(skills.some((s) => s.name === "skipped-skill")).toBe(false);
    } finally {
      if (previousClaudiaHome === undefined) {
        delete process.env.CLAUDIA_HOME;
      } else {
        process.env.CLAUDIA_HOME = previousClaudiaHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("formats only visible skills for the system prompt", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "visible-skill",
        description: "A visible helper.",
        filePath: "/tmp/visible/SKILL.md",
        baseDir: "/tmp/visible",
        source: "project",
        disableModelInvocation: false,
      },
      {
        name: "hidden-skill",
        description: "A hidden helper.",
        filePath: "/tmp/hidden/SKILL.md",
        baseDir: "/tmp/hidden",
        source: "project",
        disableModelInvocation: true,
      },
    ]);

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>visible-skill</name>");
    expect(prompt).not.toContain("<name>hidden-skill</name>");
  });

  it("loads additive paths and resolves relative paths against cwd", () => {
    const tempRoot = join(tmpdir(), `claudia-skills-config-${Date.now()}`);
    const cwd = join(tempRoot, "workspace", "app");
    const relativeDir = join(tempRoot, "workspace", "custom-skills");
    const absoluteDir = join(tempRoot, "external-skills");
    const home = join(tempRoot, "home");
    const previousClaudiaHome = process.env.CLAUDIA_HOME;

    try {
      process.env.CLAUDIA_HOME = home;
      mkdirSync(cwd, { recursive: true });
      mkdirSync(relativeDir, { recursive: true });
      mkdirSync(join(absoluteDir, "absolute-skill"), { recursive: true });
      mkdirSync(join(home, ".claudia", "skills"), { recursive: true });

      writeFileSync(
        join(relativeDir, "relative.md"),
        ["---", "name: relative-skill", "description: Relative path skill.", "---"].join("\n"),
      );
      writeFileSync(
        join(absoluteDir, "absolute-skill", "SKILL.md"),
        ["---", "name: absolute-skill", "description: Absolute path skill.", "---"].join("\n"),
      );
      writeFileSync(
        join(home, ".claudia", "skills", "home.md"),
        ["---", "name: home-skill", "description: Home path skill.", "---"].join("\n"),
      );

      const skills = loadSkills({
        cwd,
        additionalPaths: ["../custom-skills", absoluteDir, "~/.claudia/skills"],
      });
      const names = skills.map((s) => s.name);

      expect(names.includes("relative-skill")).toBe(true);
      expect(names.includes("absolute-skill")).toBe(true);
      expect(names.includes("home-skill")).toBe(true);
    } finally {
      if (previousClaudiaHome === undefined) {
        delete process.env.CLAUDIA_HOME;
      } else {
        process.env.CLAUDIA_HOME = previousClaudiaHome;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
