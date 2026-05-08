import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles } from "./file-discovery";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudia-files-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  // Configure a local user so commits would work if we ever needed them.
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

describe("file-discovery", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("uses git ls-files inside a git repo and returns relative paths", () => {
    const repo = makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, "README.md"), "# hi\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "index.ts"), "export {};\n");

    const result = listFiles({ cwd: repo });
    expect(result.source).toBe("git");
    expect(result.files.sort()).toEqual(["README.md", "src/index.ts"]);
  });

  it("respects .gitignore (the headline reason we use git ls-files)", () => {
    const repo = makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\nsecrets.env\n");
    writeFileSync(join(repo, "package.json"), "{}\n");
    writeFileSync(join(repo, "secrets.env"), "X=1\n");
    writeFileSync(join(repo, "debug.log"), "noise\n");
    mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "//\n");

    const { files, source } = listFiles({ cwd: repo });
    expect(source).toBe("git");
    expect(files).toContain(".gitignore");
    expect(files).toContain("package.json");
    expect(files).not.toContain("secrets.env");
    expect(files).not.toContain("debug.log");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("includes untracked files (not just the index)", () => {
    const repo = makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, "tracked.md"), "tracked\n");
    spawnSync("git", ["add", "tracked.md"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    // New, untracked file added after commit — picker should still see it.
    writeFileSync(join(repo, "new-untracked.md"), "fresh\n");

    const { files } = listFiles({ cwd: repo });
    expect(files).toContain("tracked.md");
    expect(files).toContain("new-untracked.md");
  });

  it("falls back to a walk when cwd isn't a git repo, skipping heavy dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudia-files-nogit-"));
    dirs.push(dir);
    writeFileSync(join(dir, "README.md"), "# hi\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "//\n");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const { files, source } = listFiles({ cwd: dir });
    expect(source).toBe("walk");
    expect(files.sort()).toEqual(["README.md", "src/index.ts"]);
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
    expect(files.some((f) => f.startsWith(".git"))).toBe(false);
  });
});
