import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireMemoryExtensionLock,
  closeDb,
  getDb,
  getMemoryExtensionLockStatus,
  releaseMemoryExtensionLock,
  renewMemoryExtensionLock,
  setDbPathForTests,
} from "./db";

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

describe("memory singleton lock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudia-memory-lock-"));
    setDbPathForTests(join(tempDir, "claudia.test.db"));
    setupSchema();
  });

  afterEach(() => {
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("acquires lock when none exists", () => {
    const result = acquireMemoryExtensionLock(1111, 60_000);
    expect(result.acquired).toBe(true);
    expect(result.ownerPid).toBe(1111);

    const status = getMemoryExtensionLockStatus(60_000);
    expect(status).not.toBeNull();
    expect(status?.ownerPid).toBe(1111);
    expect(status?.stale).toBe(false);
  });

  it("rejects a second process when lock is fresh", () => {
    expect(acquireMemoryExtensionLock(1111, 60_000).acquired).toBe(true);

    const result = acquireMemoryExtensionLock(2222, 60_000);
    expect(result.acquired).toBe(false);
    expect(result.ownerPid).toBe(1111);
  });

  it("steals lock when heartbeat is stale", () => {
    expect(acquireMemoryExtensionLock(1111, 60_000).acquired).toBe(true);

    getDb()
      .query("UPDATE memory_extension_locks SET last_heartbeat = datetime('now', '-5 minutes')")
      .run();

    const result = acquireMemoryExtensionLock(2222, 60_000);
    expect(result.acquired).toBe(true);
    expect(result.stolen).toBe(true);
    expect(result.previousOwnerPid).toBe(1111);

    const status = getMemoryExtensionLockStatus(60_000);
    expect(status?.ownerPid).toBe(2222);
  });

  it("renews and releases only for current owner", () => {
    expect(acquireMemoryExtensionLock(1111, 60_000).acquired).toBe(true);

    expect(renewMemoryExtensionLock(2222)).toBe(false);
    expect(renewMemoryExtensionLock(1111)).toBe(true);

    expect(releaseMemoryExtensionLock(2222)).toBe(false);
    expect(releaseMemoryExtensionLock(1111)).toBe(true);
    expect(getMemoryExtensionLockStatus(60_000)).toBeNull();
  });
});
