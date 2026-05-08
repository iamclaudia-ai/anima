import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCommandsCache, listCommands } from "./commands-discovery";

function writeSkill(skillsDir: string, name: string, frontmatter: Record<string, string>): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: "${v.replaceAll('"', '\\"')}"`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${fmLines}\n---\n\n# ${name}\n`, "utf8");
}

function writeCommand(commandsDir: string, name: string, description: string): void {
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(
    join(commandsDir, `${name}.md`),
    `---\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
    "utf8",
  );
}

describe("commands-discovery", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  const dirs: string[] = [];

  beforeEach(() => {
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "claudia-commands-home-"));
    process.env.HOME = fakeHome;
    dirs.push(fakeHome);
    clearCommandsCache();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("scans global skills and parses frontmatter", () => {
    const skillsDir = join(fakeHome, ".claude", "skills");
    writeSkill(skillsDir, "browsing-the-web", {
      name: "browsing-the-web",
      description: "Browse websites and automate browser tasks.",
    });
    writeSkill(skillsDir, "browsing-twitter", {
      name: "browsing-twitter",
      description: "Read and post tweets through the bird CLI.",
    });

    const { items } = listCommands({ home: fakeHome });
    expect(items).toHaveLength(2);
    const web = items.find((i) => i.name === "browsing-the-web");
    expect(web?.description).toBe("Browse websites and automate browser tasks.");
    expect(web?.source).toBe("global");
  });

  it("scans global commands using filename as name", () => {
    const commandsDir = join(fakeHome, ".claude", "commands");
    writeCommand(commandsDir, "podcast", "Create a podcast episode idea from the conversation");

    const { items } = listCommands({ home: fakeHome });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "podcast",
      description: "Create a podcast episode idea from the conversation",
      source: "global",
    });
  });

  it("merges project entries and shadows global on name collision", () => {
    const globalSkills = join(fakeHome, ".claude", "skills");
    writeSkill(globalSkills, "shared", { name: "shared", description: "global version" });
    writeSkill(globalSkills, "global-only", {
      name: "global-only",
      description: "only in global",
    });

    const projectCwd = mkdtempSync(join(tmpdir(), "claudia-commands-project-"));
    dirs.push(projectCwd);
    const projectSkills = join(projectCwd, ".claude", "skills");
    writeSkill(projectSkills, "shared", { name: "shared", description: "project version" });
    writeSkill(projectSkills, "project-only", {
      name: "project-only",
      description: "only in project",
    });

    const { items } = listCommands({ cwd: projectCwd, home: fakeHome });
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(items).toHaveLength(3);
    expect(byName.get("shared")?.description).toBe("project version");
    expect(byName.get("shared")?.source).toBe("project");
    expect(byName.get("global-only")?.source).toBe("global");
    expect(byName.get("project-only")?.source).toBe("project");
  });

  it("returns empty list when no skill/command directories exist", () => {
    const { items } = listCommands({ home: fakeHome });
    expect(items).toEqual([]);
  });

  it("sorts results alphabetically by name", () => {
    const skillsDir = join(fakeHome, ".claude", "skills");
    writeSkill(skillsDir, "zebra", { name: "zebra", description: "z" });
    writeSkill(skillsDir, "alpha", { name: "alpha", description: "a" });
    writeSkill(skillsDir, "mango", { name: "mango", description: "m" });

    const { items } = listCommands({ home: fakeHome });
    expect(items.map((i) => i.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("caches results and re-scans when a directory mtime changes", () => {
    const skillsDir = join(fakeHome, ".claude", "skills");
    writeSkill(skillsDir, "first", { name: "first", description: "1" });

    const initial = listCommands({ home: fakeHome });
    expect(initial.items).toHaveLength(1);

    // Adding a new skill bumps the skills/ dir mtime, so the cache should miss.
    // Sleep briefly to ensure the mtime resolution actually changes.
    const start = Date.now();
    while (Date.now() - start < 20) {
      // spin
    }
    writeSkill(skillsDir, "second", { name: "second", description: "2" });

    const updated = listCommands({ home: fakeHome });
    expect(updated.items).toHaveLength(2);
  });
});
