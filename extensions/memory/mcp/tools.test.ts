import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMemoryPath } from "./storage";
import { handleNote, memoryMcpTools } from "./tools";

let root: string;
const previous = process.env.ANIMA_MEMORY_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anima-memory-"));
  process.env.ANIMA_MEMORY_DIR = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ANIMA_MEMORY_DIR;
  else process.env.ANIMA_MEMORY_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function tool(name: string) {
  const found = memoryMcpTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("resolveMemoryPath", () => {
  it("resolves relative, ~/memory and in-root absolute paths", () => {
    expect(resolveMemoryPath("core/identity.md", "/m")).toBe("/m/core/identity.md");
    expect(resolveMemoryPath("~/memory/core/identity.md", "/m")).toBe("/m/core/identity.md");
    expect(resolveMemoryPath("/m/core/identity.md", "/m")).toBe("/m/core/identity.md");
  });

  it("rejects anything outside the root", () => {
    for (const path of [
      "/Users/michael/.anima/anima.json",
      "../.anima/anima.json",
      "core/../../.zshenv",
      "~/memory/../.ssh/id_ed25519",
      "/m-other/file.md",
      ".",
    ]) {
      expect(() => resolveMemoryPath(path, "/m")).toThrow("outside ~/memory");
    }
  });
});

describe("memory_read", () => {
  it("refuses to read a file outside ~/memory", async () => {
    const secret = join(root, "..", `secret-${Date.now()}.json`);
    writeFileSync(secret, '{"token":"hunter2"}');
    try {
      const result = await tool("memory_read").handle({ filepath: secret }, undefined as never);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("hunter2");
    } finally {
      rmSync(secret, { force: true });
    }
  });
});

describe("memory_note", () => {
  it("creates a notebook, then appends under sections", async () => {
    const first = JSON.parse(
      await handleNote({ notebook: "mail", section: "Acme", content: "Jane wants the Q3 report." }),
    );
    expect(first).toMatchObject({ filepath: "notebooks/mail.md", isNewFile: true });

    const second = JSON.parse(
      await handleNote({ notebook: "mail", section: "Acme", content: "Sent it Friday." }),
    );
    expect(second).toMatchObject({ isNewFile: false, isNewSection: false });

    const text = readFileSync(join(root, "notebooks", "mail.md"), "utf-8");
    expect(text).toContain("## Acme");
    expect(text).toContain("Jane wants the Q3 report.");
    expect(text).toContain("Sent it Friday.");
  });

  it("defaults the section to today's date and flattens headings out of it", async () => {
    const dated = JSON.parse(await handleNote({ notebook: "mail", content: "x" }));
    expect(dated.section).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const flat = JSON.parse(
      await handleNote({ notebook: "mail", section: "a\n## b", content: "y" }),
    );
    expect(flat.section).toBe("a b");
  });

  it("only ever writes inside notebooks/", async () => {
    mkdirSync(join(root, "personas"), { recursive: true });
    for (const notebook of [
      "../personas/claudia",
      "personas/claudia",
      "Mail",
      "",
      "a".repeat(41),
    ]) {
      await expect(handleNote({ notebook, content: "pwned" })).rejects.toThrow("notebook must");
    }
    await expect(handleNote({ notebook: "mail", content: "  " })).rejects.toThrow("content");
  });
});
