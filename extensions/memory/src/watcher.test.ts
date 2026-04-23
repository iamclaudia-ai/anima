import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryWatcher, shouldIgnorePath } from "./watcher";

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

  it("does not ignore unknown paths before file stats are available", () => {
    expect(shouldIgnorePath("/Users/michael/.claude/projects")).toBe(false);
    expect(shouldIgnorePath("/Users/michael/.claude/projects/foo.txt")).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 500, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("MemoryWatcher ingestion machine", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coalesces rapid duplicate changes for the same file", async () => {
    const basePath = mkdtempSync(join(tmpdir(), "anima-memory-watcher-"));
    tempDirs.push(basePath);
    const ingests: string[] = [];
    const watcher = new MemoryWatcher(
      {
        basePath,
        gapMinutes: 60,
        exclude: [],
        debounceMs: 20,
        hotDebounceMs: 40,
        maxCoalesceMs: 80,
        minReingestIntervalMs: 0,
        errorBackoffMs: 10,
      },
      () => {},
      {
        ingestFile(filePath) {
          ingests.push(filePath);
          return {
            filesProcessed: 1,
            entriesInserted: 1,
            entriesDeleted: 0,
            conversationsUpdated: 0,
            errors: [],
          };
        },
        yieldToEventLoop: async () => {},
      },
    );

    try {
      watcher.noteFileChanged(join(basePath, "session.jsonl"));
      watcher.noteFileChanged(join(basePath, "session.jsonl"));
      watcher.noteFileChanged(join(basePath, "session.jsonl"));

      await waitFor(() => ingests.length === 1, 300);

      const diagnostics = watcher.getDiagnostics();
      expect(ingests).toEqual([join(basePath, "session.jsonl")]);
      expect(diagnostics.queueDepth).toBe(0);
      expect(diagnostics.lastIngestFile).toBe(join(basePath, "session.jsonl"));
      expect(diagnostics.lastIngestEntries).toBe(1);
    } finally {
      await watcher.stop();
    }
  });

  it("eventually ingests a hot file under continuous writes", async () => {
    const basePath = mkdtempSync(join(tmpdir(), "anima-memory-watcher-"));
    tempDirs.push(basePath);
    const ingestTimes: number[] = [];
    const watcher = new MemoryWatcher(
      {
        basePath,
        gapMinutes: 60,
        exclude: [],
        debounceMs: 25,
        hotDebounceMs: 50,
        maxCoalesceMs: 90,
        minReingestIntervalMs: 0,
        errorBackoffMs: 10,
      },
      () => {},
      {
        ingestFile() {
          ingestTimes.push(Date.now());
          return {
            filesProcessed: 1,
            entriesInserted: 2,
            entriesDeleted: 0,
            conversationsUpdated: 1,
            errors: [],
          };
        },
        yieldToEventLoop: async () => {},
      },
    );

    try {
      const filePath = join(basePath, "hot.jsonl");
      for (let i = 0; i < 8; i++) {
        watcher.noteFileChanged(filePath);
        await Bun.sleep(15);
      }

      await waitFor(() => ingestTimes.length >= 1, 400);

      const diagnostics = watcher.getDiagnostics();
      expect(ingestTimes.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics.lastIngestFile).toBe(filePath);
      expect(diagnostics.hotFiles).toBeGreaterThanOrEqual(0);
      expect(["idle", "coalescing", "ready", "ingesting"]).toContain(diagnostics.state);
    } finally {
      await watcher.stop();
    }
  });
});
