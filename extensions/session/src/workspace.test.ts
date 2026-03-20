import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  closeDb,
  createWorkspace,
  getOrCreateWorkspace,
  getWorkspace,
  getWorkspaceByCwd,
  listWorkspaces,
} from "./workspace";

describe("workspace db", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.ANIMA_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "claudia-workspace-db-"));
    process.env.ANIMA_DATA_DIR = dataDir;
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (prevDataDir === undefined) {
      delete process.env.ANIMA_DATA_DIR;
    } else {
      process.env.ANIMA_DATA_DIR = prevDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates, fetches, and lists workspaces", () => {
    const cwd = join(dataDir, "repo", "a");
    const created = createWorkspace({ name: "project-a", cwd });
    expect(created.id).toMatch(/^ws_/);
    expect(created.name).toBe("project-a");
    expect(created.cwd).toBe(cwd);

    const byId = getWorkspace(created.id);
    expect(byId).toEqual(created);

    const byCwd = getWorkspaceByCwd(cwd);
    expect(byCwd).toEqual(created);

    const listed = listWorkspaces();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
  });

  it("getOrCreateWorkspace is idempotent per cwd", () => {
    const cwd = join(dataDir, "repo", "b");
    const first = getOrCreateWorkspace(cwd, "project-b");
    expect(first.created).toBe(true);
    expect(first.workspace.name).toBe("project-b");

    const second = getOrCreateWorkspace(cwd, "ignored-name");
    expect(second.created).toBe(false);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.workspace.name).toBe("project-b");
  });

  it("derives workspace name from cwd basename when name is omitted", () => {
    const result = getOrCreateWorkspace(join(dataDir, "repo", "my-folder"));
    expect(result.created).toBe(true);
    expect(result.workspace.name).toBe("my-folder");
  });

  it("expands tilde paths and creates directories recursively", () => {
    const uniqueFolder = `claudia-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tildePath = `~/projects/${uniqueFolder}`;
    const expectedPath = join(homedir(), "projects", uniqueFolder);

    try {
      const result = getOrCreateWorkspace(tildePath, "claudia");
      expect(result.created).toBe(true);
      expect(result.workspace.cwd).toBe(expectedPath);
      expect(statSync(expectedPath).isDirectory()).toBe(true);
    } finally {
      rmSync(expectedPath, { recursive: true, force: true });
    }
  });

  it("throws when cwd exists as a file", () => {
    const filePath = join(dataDir, "not-a-directory");
    writeFileSync(filePath, "x");

    expect(() => getOrCreateWorkspace(filePath)).toThrow("Path exists but is not a directory");
  });

  it("reopens database after closeDb without data loss", () => {
    const created = createWorkspace({ name: "project-c", cwd: "/repo/c" });
    closeDb();

    const listed = listWorkspaces();
    expect(listed.some((w) => w.id === created.id)).toBe(true);
  });

  it("returns null for missing workspace id/cwd lookups", () => {
    expect(getWorkspace("ws_missing")).toBeNull();
    expect(getWorkspaceByCwd(join(dataDir, "repo", "missing"))).toBeNull();
  });
});
