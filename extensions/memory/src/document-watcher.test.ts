import { describe, expect, it } from "bun:test";
import { DocumentWatcher } from "./document-watcher";

async function waitFor(predicate: () => boolean, timeoutMs = 500, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("DocumentWatcher", () => {
  it("coalesces repeated markdown changes for the same file", async () => {
    const indexed: string[] = [];
    const watcher = new DocumentWatcher(
      "/tmp/memory",
      async (filePath) => {
        indexed.push(filePath);
      },
      () => {},
      {
        debounceMs: 20,
        hotDebounceMs: 40,
        maxCoalesceMs: 80,
      },
    );

    try {
      watcher.noteFileChanged("/tmp/memory/day.md");
      watcher.noteFileChanged("/tmp/memory/day.md");
      watcher.noteFileChanged("/tmp/memory/day.md");

      await waitFor(() => indexed.length === 1, 300);

      const diagnostics = watcher.getDiagnostics();
      expect(indexed).toEqual(["/tmp/memory/day.md"]);
      expect(diagnostics.lastIndexedFile).toBe("/tmp/memory/day.md");
      expect(diagnostics.queueDepth).toBe(0);
    } finally {
      await watcher.stop();
    }
  });

  it("eventually indexes a hot markdown file under continuous writes", async () => {
    const indexedAt: number[] = [];
    const watcher = new DocumentWatcher(
      "/tmp/memory",
      async () => {
        indexedAt.push(Date.now());
      },
      () => {},
      {
        debounceMs: 25,
        hotDebounceMs: 50,
        maxCoalesceMs: 90,
      },
    );

    try {
      for (let i = 0; i < 8; i++) {
        watcher.noteFileChanged("/tmp/memory/notes.md");
        await Bun.sleep(15);
      }

      await waitFor(() => indexedAt.length >= 1, 400);

      const diagnostics = watcher.getDiagnostics();
      expect(indexedAt.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics.lastIndexedFile).toBe("/tmp/memory/notes.md");
      expect(["idle", "coalescing", "indexing"]).toContain(diagnostics.state);
    } finally {
      await watcher.stop();
    }
  });
});
