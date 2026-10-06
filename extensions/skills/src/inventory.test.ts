import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInventory,
  parseSkillFrontmatter,
  projectRootsFromWorkspaces,
  type SkillInventory,
  type SkillRecord,
} from "./inventory";

function skill(dir: string, frontmatter: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody.\n`);
}

describe("parseSkillFrontmatter", () => {
  it("reads folded block scalars as one line", () => {
    const meta = parseSkillFrontmatter(
      "---\nname: x\ndescription: >\n  first line\n  second\n---\n",
    );
    expect(meta).toEqual({ name: "x", description: "first line second" });
  });

  it("falls back to a lenient read when the YAML is invalid", () => {
    // An unquoted value containing ": " is not valid YAML, but Claude Code accepts it.
    const meta = parseSkillFrontmatter(
      "---\nname: y\ndescription: MUST be used. Triggers on: a, b\n---\n",
    );
    expect(meta).toEqual({ name: "y", description: "MUST be used. Triggers on: a, b" });
  });

  it("returns nothing without frontmatter", () => {
    expect(parseSkillFrontmatter("# Just a heading\n")).toEqual({});
  });
});

describe("buildInventory", () => {
  let root: string;
  let home: string;
  let repo: string;
  let app: string;
  let worktree: string;
  let inv: SkillInventory;

  const find = (id: string, source?: string): SkillRecord => {
    const hit = inv.skills.find((s) => s.id === id && (!source || s.source === source));
    if (!hit) throw new Error(`no skill ${id} (${source ?? "any"})`);
    return hit;
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "anima-skills-inv-")));
    home = join(root, "home");
    repo = join(root, "skills-repo");
    app = join(root, "projects", "app");
    worktree = join(root, "projects", "app.worktrees", "pr-1");
    const global = join(home, ".claude", "skills");
    mkdirSync(global, { recursive: true });

    // Repo: one linked globally, one linked into a project, one not linked anywhere.
    skill(join(repo, "linked"), 'name: linked\ndescription: "Linked globally"');
    skill(join(repo, "scoped"), 'name: scoped\ndescription: "Linked into app only"');
    skill(join(repo, "idle"), 'name: idle\ndescription: "Available, not placed"');
    symlinkSync(join(repo, "linked"), join(global, "linked"));

    // Third-party drop, a synced bucket, a broken link, and a dir with no SKILL.md.
    skill(join(global, "vendor-tool"), 'name: vendor-tool\ndescription: "Installed by a tool"');
    skill(join(global, "synced", "bucket-1", "docx"), 'name: docx\ndescription: "claude.ai"');
    symlinkSync(join(root, "missing"), join(global, "dangling"));
    mkdirSync(join(global, "empty-dir"));

    // Project-owned skills, present in a repo and in its worktree (same name, never loaded together).
    for (const project of [app, worktree]) {
      skill(join(project, ".claude", "skills", "deploy"), 'name: deploy\ndescription: "Ships it"');
    }
    // A project skill that shadows a global one.
    skill(join(app, ".claude", "skills", "linked"), 'name: linked\ndescription: "Local copy"');
    // Our repo skill placed into the project.
    symlinkSync(join(repo, "scoped"), join(app, ".claude", "skills", "scoped"));

    inv = buildInventory({
      home,
      repoPath: repo,
      projects: [app, worktree],
      overrides: { idle: "off", "vendor-tool": "name-only", deploy: "bogus" },
      repoStatus: () => [" M linked/SKILL.md"],
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists repo skills even when they are not placed anywhere", () => {
    expect(find("idle", "repo").placements).toEqual([]);
  });

  it("records a global symlink into the repo as a placement of the repo skill", () => {
    expect(find("linked", "repo").placements).toEqual([
      {
        scope: "global",
        project: undefined,
        path: join(home, ".claude", "skills", "linked"),
        kind: "symlink",
      },
    ]);
  });

  it("records a project symlink into the repo as a project placement", () => {
    const scoped = find("scoped", "repo");
    expect(scoped.placements.map((p) => [p.scope, p.project, p.kind])).toEqual([
      ["project", app, "symlink"],
    ]);
  });

  it("classifies third-party, synced, and project-owned skills", () => {
    expect(find("vendor-tool").source).toBe("third-party");
    expect(find("docx").source).toBe("synced");
    expect(inv.skills.filter((s) => s.id === "deploy").map((s) => s.source)).toEqual([
      "project",
      "project",
    ]);
  });

  it("parses descriptions and reads visibility from skillOverrides", () => {
    expect(find("idle").description).toBe("Available, not placed");
    expect(find("idle").visibility).toBe("off");
    expect(find("vendor-tool").visibility).toBe("name-only");
    expect(find("linked", "repo").visibility).toBe("on");
    // An unrecognized override value is treated as no override.
    expect(find("deploy").visibility).toBe("on");
  });

  it("reports broken links and directories without SKILL.md", () => {
    const problems = inv.problems.map((p) => p.problem);
    expect(problems).toContain("broken symlink");
    expect(problems).toContain("no SKILL.md");
  });

  it("reports a project skill shadowing a global one, but not repo/worktree twins", () => {
    const shadows = inv.problems.filter((p) => p.problem.startsWith("shadows"));
    expect(shadows).toEqual([
      {
        path: join(app, ".claude", "skills", "linked"),
        problem: `shadows the global skill "linked" in ${app}`,
      },
    ]);
    expect(inv.problems.some((p) => p.problem.includes('"deploy"'))).toBe(false);
  });

  it("surfaces uncommitted changes in the skills repo", () => {
    expect(inv.repo).toEqual({ path: repo, dirty: [" M linked/SKILL.md"] });
  });

  it("works with no repo configured", () => {
    const bare = buildInventory({ home, repoPath: null, projects: [], overrides: {} });
    expect(bare.repo).toBeNull();
    // The global symlink still resolves; without a repo it counts as third-party.
    expect(bare.skills.find((s) => s.id === "linked")?.source).toBe("third-party");
  });
});

describe("projectRootsFromWorkspaces", () => {
  it("skips scratch dirs and missing paths, and dedupes", () => {
    const real = realpathSync(tmpdir());
    expect(
      projectRootsFromWorkspaces([real, real, "/private/tmp/scratch/x", "/nonexistent/path"]),
    ).toEqual([real]);
  });
});
