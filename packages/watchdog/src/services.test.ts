import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHealth, type ManagedService } from "./services";

function makeService(overrides: Partial<ManagedService> = {}): ManagedService {
  return {
    name: "Gateway",
    id: "gateway",
    command: ["bun", "run", "packages/gateway/src/start.ts"],
    cwd: "/tmp/test",
    healthUrl: "http://localhost:30086/health",
    port: 30086,
    requireExtensions: true,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
    lastHealthDetails: null,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
const originalDbPath = process.env.ANIMA_DB_PATH;
const tempDirs: string[] = [];

function useTempDbPath(filename = "anima.db"): string {
  const tempDir = mkdtempSync(join(tmpdir(), "watchdog-db-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, filename);
  process.env.ANIMA_DB_PATH = dbPath;
  return dbPath;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDbPath === undefined) delete process.env.ANIMA_DB_PATH;
  else process.env.ANIMA_DB_PATH = originalDbPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("watchdog health checks", () => {
  it("marks gateway unhealthy when health endpoint reports zero extensions", async () => {
    useTempDbPath();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "ok", extensions: {} }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await checkHealth(makeService());
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe("zero_extensions");
  });

  it("marks gateway healthy when at least one extension is loaded", async () => {
    useTempDbPath();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "ok", extensions: { session: { ok: true } } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await checkHealth(makeService());
    expect(result.healthy).toBe(true);
  });

  it("treats non-gateway service as healthy on HTTP 200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    const result = await checkHealth(
      makeService({
        id: "agent-host",
        name: "Agent Host",
        healthUrl: "http://localhost:30087/health",
        requireExtensions: false,
      }),
    );
    expect(result.healthy).toBe(true);
  });

  it("marks gateway unhealthy when memory lock heartbeat is stale", async () => {
    const dbPath = useTempDbPath();

    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE memory_extension_locks (
          lock_id TEXT PRIMARY KEY,
          owner_pid INTEGER NOT NULL,
          acquired_at TEXT NOT NULL,
          last_heartbeat TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.query(
        `INSERT INTO memory_extension_locks
             (lock_id, owner_pid, acquired_at, last_heartbeat, updated_at)
           VALUES ('memory-extension', ?, datetime('now', '-10 minutes'), datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`,
      ).run(process.pid);

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ status: "ok", extensions: { memory: { ok: true } } }), {
          status: 200,
        })) as unknown as typeof fetch;

      const result = await checkHealth(makeService());
      expect(result.healthy).toBe(false);
      expect(result.reason).toBe("memory_stale_lock");
      expect(result.details).toMatchObject({
        memoryLock: {
          ownerPid: process.pid,
          stale: true,
          ownerAlive: true,
        },
      });
    } finally {
      db.close(false);
    }
  });
});
