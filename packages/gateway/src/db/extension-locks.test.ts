import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  acquireExtensionProcessLock,
  getExtensionProcessLocks,
  releaseExtensionProcessLock,
  renewExtensionProcessLock,
} from "./extension-locks";

let db: Database;

function setupSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_process_locks (
      extension_id TEXT PRIMARY KEY,
      owner_pid INTEGER NOT NULL,
      owner_instance_id TEXT NOT NULL,
      owner_generation TEXT,
      acquired_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_extension_process_locks_updated
    ON extension_process_locks(updated_at);
  `);
}

describe("extension process locks", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    setupSchema();
  });

  afterEach(() => {
    db.close();
  });

  it("acquires lock when none exists", () => {
    const res = acquireExtensionProcessLock("voice", 1001, "gw-a", "gen-1", 120_000, db);
    expect(res.acquired).toBe(true);

    const locks = getExtensionProcessLocks(120_000, db);
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({
      extensionId: "voice",
      ownerPid: 1001,
      ownerInstanceId: "gw-a",
      ownerGeneration: "gen-1",
      stale: false,
    });
  });

  it("rejects lock when fresh owner exists", () => {
    expect(acquireExtensionProcessLock("voice", 1001, "gw-a", "gen-1", 120_000, db).acquired).toBe(
      true,
    );

    const second = acquireExtensionProcessLock("voice", 2002, "gw-b", "gen-x", 120_000, db);
    expect(second.acquired).toBe(false);
    expect(second.ownerPid).toBe(1001);
    expect(second.ownerInstanceId).toBe("gw-a");
  });

  it("steals stale locks", () => {
    expect(acquireExtensionProcessLock("voice", 1001, "gw-a", "gen-1", 120_000, db).acquired).toBe(
      true,
    );

    db.query("UPDATE extension_process_locks SET updated_at = ? WHERE extension_id = ?").run(
      Date.now() - 5 * 60_000,
      "voice",
    );

    const stolen = acquireExtensionProcessLock("voice", 2002, "gw-b", "gen-2", 60_000, db);
    expect(stolen.acquired).toBe(true);
    expect(stolen.stolen).toBe(true);

    const locks = getExtensionProcessLocks(120_000, db);
    expect(locks[0]).toMatchObject({
      extensionId: "voice",
      ownerPid: 2002,
      ownerInstanceId: "gw-b",
      ownerGeneration: "gen-2",
      stale: false,
    });
  });

  it("renews and releases only for owner", () => {
    expect(acquireExtensionProcessLock("memory", 1234, "gw-a", "g1", 120_000, db).acquired).toBe(
      true,
    );

    expect(renewExtensionProcessLock("memory", 9999, "gw-z", "gz", db)).toBe(false);
    expect(renewExtensionProcessLock("memory", 1234, "gw-a", "g2", db)).toBe(true);

    expect(releaseExtensionProcessLock("memory", 9999, "gw-z", db)).toBe(false);
    expect(releaseExtensionProcessLock("memory", 1234, "gw-a", db)).toBe(true);
    expect(getExtensionProcessLocks(120_000, db)).toHaveLength(0);
  });
});
