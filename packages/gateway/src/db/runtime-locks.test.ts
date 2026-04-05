import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  acquireExtensionRuntimeLock,
  getExtensionRuntimeLocks,
  releaseExtensionRuntimeLock,
  renewExtensionRuntimeLock,
} from "./runtime-locks";

let db: Database;

function setupSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_runtime_locks (
      extension_id TEXT NOT NULL,
      lock_type TEXT NOT NULL,
      resource_key TEXT NOT NULL DEFAULT '__default__',
      holder_pid INTEGER,
      holder_instance_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      stale_after_ms INTEGER NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (extension_id, lock_type, resource_key)
    );
  `);
}

describe("extension runtime locks", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    setupSchema();
  });

  afterEach(() => {
    db.close();
  });

  it("acquires a singleton lock when none exists", () => {
    const result = acquireExtensionRuntimeLock(
      {
        extensionId: "memory",
        lockType: "singleton",
        holderPid: 1234,
        holderInstanceId: "memory:1234",
      },
      db,
    );

    expect(result.acquired).toBe(true);
    expect(result.lock).toMatchObject({
      extensionId: "memory",
      lockType: "singleton",
      resourceKey: "__default__",
      holderPid: 1234,
      holderInstanceId: "memory:1234",
      stale: false,
    });
  });

  it("rejects acquisition when a fresh owner exists", () => {
    acquireExtensionRuntimeLock(
      {
        extensionId: "memory",
        lockType: "singleton",
        holderPid: 1234,
        holderInstanceId: "memory:1234",
      },
      db,
    );

    const second = acquireExtensionRuntimeLock(
      {
        extensionId: "memory",
        lockType: "singleton",
        holderPid: 5678,
        holderInstanceId: "memory:5678",
      },
      db,
    );

    expect(second.acquired).toBe(false);
    expect(second.lock).toMatchObject({
      holderPid: 1234,
      holderInstanceId: "memory:1234",
    });
  });

  it("steals a stale lock", () => {
    acquireExtensionRuntimeLock(
      {
        extensionId: "memory",
        lockType: "singleton",
        holderPid: 1234,
        holderInstanceId: "memory:1234",
        staleAfterMs: 100,
      },
      db,
    );

    db.query(
      `UPDATE extension_runtime_locks
       SET updated_at = ?
       WHERE extension_id = 'memory' AND lock_type = 'singleton' AND resource_key = '__default__'`,
    ).run(Date.now() - 1000);

    const stolen = acquireExtensionRuntimeLock(
      {
        extensionId: "memory",
        lockType: "singleton",
        holderPid: 5678,
        holderInstanceId: "memory:5678",
        staleAfterMs: 100,
      },
      db,
    );

    expect(stolen.acquired).toBe(true);
    expect(stolen.stolen).toBe(true);
    expect(stolen.previousOwner).toEqual({
      holderPid: 1234,
      holderInstanceId: "memory:1234",
    });
  });

  it("renews and releases only for the owner", () => {
    acquireExtensionRuntimeLock(
      {
        extensionId: "memory",
        lockType: "singleton",
        holderPid: 1234,
        holderInstanceId: "memory:1234",
      },
      db,
    );

    expect(
      renewExtensionRuntimeLock(
        {
          extensionId: "memory",
          lockType: "singleton",
          holderPid: 9999,
          holderInstanceId: "other",
        },
        db,
      ),
    ).toBe(false);
    expect(
      renewExtensionRuntimeLock(
        {
          extensionId: "memory",
          lockType: "singleton",
          holderPid: 1234,
          holderInstanceId: "memory:1234",
        },
        db,
      ),
    ).toBe(true);

    expect(
      releaseExtensionRuntimeLock(
        {
          extensionId: "memory",
          lockType: "singleton",
          holderPid: 9999,
          holderInstanceId: "other",
        },
        db,
      ),
    ).toBe(false);
    expect(
      releaseExtensionRuntimeLock(
        {
          extensionId: "memory",
          lockType: "singleton",
          holderPid: 1234,
          holderInstanceId: "memory:1234",
        },
        db,
      ),
    ).toBe(true);
    expect(getExtensionRuntimeLocks(undefined, db)).toHaveLength(0);
  });
});
