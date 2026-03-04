import { describe, expect, it } from "bun:test";
import { shouldIgnorePath } from "./watcher";

const fileStats = {
  isFile: () => true,
  isDirectory: () => false,
};

const dirStats = {
  isFile: () => false,
  isDirectory: () => true,
};

describe("shouldIgnorePath", () => {
  it("does not ignore directories, including hidden-dot paths", () => {
    expect(shouldIgnorePath("/Users/michael/.claude/projects", dirStats)).toBe(false);
    expect(shouldIgnorePath("/Users/michael/.claude/projects/sub.dir", dirStats)).toBe(false);
  });

  it("ignores non-jsonl files when path is a file", () => {
    expect(shouldIgnorePath("/tmp/foo.txt", fileStats)).toBe(true);
    expect(shouldIgnorePath("/tmp/foo.json", fileStats)).toBe(true);
  });

  it("keeps jsonl files", () => {
    expect(shouldIgnorePath("/tmp/foo.jsonl", fileStats)).toBe(false);
  });

  it("does not ignore unknown paths before chokidar stats are available", () => {
    expect(shouldIgnorePath("/Users/michael/.claude/projects")).toBe(false);
    expect(shouldIgnorePath("/Users/michael/.claude/projects/foo.txt")).toBe(false);
  });
});
