import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, GatewayEvent } from "@anima/shared";
import { createMemoryExtension } from "./index";
import { acquireMemoryExtensionLock, closeDb, getDb, setDbPathForTests } from "./db";

function setupSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_file_states (file_path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_transcript_entries (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE IF NOT EXISTS memory_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      source_file TEXT,
      first_message_at TEXT,
      last_message_at TEXT,
      entry_count INTEGER,
      status TEXT,
      strategy TEXT,
      summary TEXT,
      processed_at TEXT,
      status_at TEXT,
      metadata TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_state_machines (
      machine_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      process_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_file_locks (
      source_file TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      locked_at TEXT NOT NULL DEFAULT (datetime('now')),
      locked_by_pid INTEGER NOT NULL,
      locked_by_machine TEXT
    );
  `);
}

function createTestContext(): ExtensionContext {
  const listeners = new Map<string, (event: GatewayEvent) => void | Promise<void>>();

  return {
    on(pattern, handler) {
      listeners.set(pattern, handler);
      return () => listeners.delete(pattern);
    },
    emit() {},
    async call() {
      return {};
    },
    connectionId: null,
    tags: null,
    config: {},
    log: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

describe("memory health lock status", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudia-memory-health-"));
    setDbPathForTests(join(tempDir, "claudia.test.db"));
    setupSchema();
  });

  afterEach(async () => {
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports degraded status when singleton lock is held by another process", async () => {
    const ext = createMemoryExtension({ watch: false, watchPath: join(tempDir, "logs") });
    const blocker = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      acquireMemoryExtensionLock(blocker.pid, 60_000);

      await ext.start(createTestContext());

      const health = (await ext.handleMethod("memory.health_check", {})) as {
        status: string;
        metrics: Array<{ label: string; value: string }>;
      };

      expect(health.status).toBe("degraded");
      const lockMetric = health.metrics.find((m) => m.label === "Singleton Lock");
      expect(lockMetric?.value).toBe("contended");
      const watcherMetric = health.metrics.find((m) => m.label === "Last File Change");
      expect(watcherMetric?.value).toBe("n/a");
    } finally {
      blocker.kill();
    }
  });
});
