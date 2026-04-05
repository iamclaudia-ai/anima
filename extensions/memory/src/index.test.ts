import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, GatewayEvent } from "@anima/shared";
import { createMemoryExtension } from "./index";
import { closeDb, getDb, setDbPathForTests } from "./db";

function setupSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_file_states (
      file_path TEXT PRIMARY KEY,
      source TEXT,
      status TEXT,
      last_modified INTEGER,
      file_size INTEGER,
      last_processed_offset INTEGER DEFAULT 0,
      last_committed_entry_id INTEGER,
      last_entry_timestamp TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_transcript_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT,
      timestamp TEXT
    );
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
    CREATE TABLE IF NOT EXISTS memory_extension_locks (
      lock_id TEXT PRIMARY KEY,
      owner_pid INTEGER NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function createTestContext(options: { preheldLockPid?: number | null } = {}): ExtensionContext {
  const listeners = new Map<string, (event: GatewayEvent) => void | Promise<void>>();
  let runtimeLock: {
    holderPid: number | null;
    holderInstanceId: string;
    staleAfterMs: number;
    updatedAt: number;
    stale: boolean;
    metadata: Record<string, unknown> | null;
  } | null =
    options.preheldLockPid != null
      ? {
          holderPid: options.preheldLockPid,
          holderInstanceId: `memory:${options.preheldLockPid}`,
          staleAfterMs: 60_000,
          updatedAt: Date.now(),
          stale: false,
          metadata: { actor: "memory", role: "singleton" } as Record<string, unknown>,
        }
      : null;

  return {
    on(pattern, handler) {
      listeners.set(pattern, handler);
      return () => listeners.delete(pattern);
    },
    emit() {},
    async call(method, params) {
      if (method === "gateway.acquire_liveness_lock") {
        if (!runtimeLock) {
          runtimeLock = {
            holderPid: (params?.holderPid as number | null) ?? null,
            holderInstanceId: params?.holderInstanceId as string,
            staleAfterMs: (params?.staleAfterMs as number) ?? 180_000,
            updatedAt: Date.now(),
            stale: false,
            metadata: (params?.metadata as Record<string, unknown>) ?? null,
          };
          return { acquired: true, lock: runtimeLock };
        }
        return { acquired: false, lock: runtimeLock };
      }
      if (method === "gateway.renew_liveness_lock") {
        if (
          runtimeLock &&
          runtimeLock.holderPid === ((params?.holderPid as number | null) ?? null) &&
          runtimeLock.holderInstanceId === (params?.holderInstanceId as string)
        ) {
          runtimeLock = { ...runtimeLock, updatedAt: Date.now(), stale: false };
          return { renewed: true };
        }
        return { renewed: false };
      }
      if (method === "gateway.release_liveness_lock") {
        if (
          runtimeLock &&
          runtimeLock.holderPid === ((params?.holderPid as number | null) ?? null) &&
          runtimeLock.holderInstanceId === (params?.holderInstanceId as string)
        ) {
          runtimeLock = null;
          return { released: true };
        }
        return { released: false };
      }
      return {};
    },
    connectionId: null,
    tags: null,
    config: {},
    store: (() => {
      const _data: Record<string, unknown> = {};
      return {
        get: <T = unknown>(key: string): T | undefined => _data[key] as T | undefined,
        set: (key: string, value: unknown) => {
          _data[key] = value;
        },
        delete: (key: string) => {
          delete _data[key];
          return true;
        },
        all: () => _data,
      };
    })(),
    log: {
      info() {},
      warn() {},
      error() {},
      child() {
        return {
          info() {},
          warn() {},
          error() {},
          child() {
            throw new Error("not implemented");
          },
        };
      },
    },
    createLogger() {
      return {
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      };
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("memory health lock status", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-memory-health-"));
    setDbPathForTests(join(tempDir, "anima.test.db"));
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
      await ext.start(createTestContext({ preheldLockPid: blocker.pid }));

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
      await ext.stop();
      blocker.kill();
    }
  });

  it("starts the scheduler independently of gateway heartbeat traffic", async () => {
    const ext = createMemoryExtension({ watch: false, watchPath: join(tempDir, "logs") });

    await ext.start(createTestContext());
    await waitFor(async () => {
      const health = (await ext.handleMethod("memory.health_check", {})) as {
        metrics: Array<{ label: string; value: string }>;
      };
      return health.metrics.some(
        (metric) => metric.label === "Scheduler Running" && metric.value === "true",
      );
    });

    const health = (await ext.handleMethod("memory.health_check", {})) as {
      metrics: Array<{ label: string; value: string }>;
    };
    const schedulerRunning = health.metrics.find((m) => m.label === "Scheduler Running");
    const schedulerLastRun = health.metrics.find((m) => m.label === "Scheduler Last Run");

    expect(schedulerRunning?.value).toBe("true");
    expect(schedulerLastRun?.value).not.toBe("n/a");

    await ext.stop();
  });
});
