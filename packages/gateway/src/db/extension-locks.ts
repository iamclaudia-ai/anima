import type { Database } from "bun:sqlite";
import { getDb } from "./connection";

export const DEFAULT_EXTENSION_LOCK_STALE_MS = 2 * 60 * 1000;

export interface AcquireExtensionLockResult {
  acquired: boolean;
  stolen?: boolean;
  alreadyOwned?: boolean;
  ownerPid?: number;
  ownerInstanceId?: string;
  ownerGeneration?: string | null;
}

export interface ExtensionProcessLockRow {
  extensionId: string;
  ownerPid: number;
  ownerInstanceId: string;
  ownerGeneration: string | null;
  acquiredAt: number;
  updatedAt: number;
  stale: boolean;
}

function dbOrDefault(d?: Database): Database {
  return d ?? getDb();
}

export function acquireExtensionProcessLock(
  extensionId: string,
  ownerPid: number,
  ownerInstanceId: string,
  ownerGeneration?: string | null,
  staleMs: number = DEFAULT_EXTENSION_LOCK_STALE_MS,
  d?: Database,
): AcquireExtensionLockResult {
  const db = dbOrDefault(d);
  const now = Date.now();

  const insert = db
    .query(
      `INSERT INTO extension_process_locks
        (extension_id, owner_pid, owner_instance_id, owner_generation, acquired_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(extension_id) DO NOTHING`,
    )
    .run(extensionId, ownerPid, ownerInstanceId, ownerGeneration ?? null, now, now);

  if (insert.changes > 0) {
    return { acquired: true };
  }

  const existing = db
    .query(
      `SELECT owner_pid AS ownerPid, owner_instance_id AS ownerInstanceId, owner_generation AS ownerGeneration, updated_at AS updatedAt
      FROM extension_process_locks
      WHERE extension_id = ?`,
    )
    .get(extensionId) as {
    ownerPid: number;
    ownerInstanceId: string;
    ownerGeneration: string | null;
    updatedAt: number;
  } | null;

  if (!existing) {
    return { acquired: false };
  }

  if (existing.ownerPid === ownerPid && existing.ownerInstanceId === ownerInstanceId) {
    db.query(
      `UPDATE extension_process_locks
       SET owner_generation = ?, updated_at = ?
       WHERE extension_id = ?`,
    ).run(ownerGeneration ?? null, now, extensionId);
    return { acquired: true, alreadyOwned: true };
  }

  if (existing.updatedAt <= now - staleMs) {
    const stolen = db
      .query(
        `UPDATE extension_process_locks
         SET owner_pid = ?, owner_instance_id = ?, owner_generation = ?, acquired_at = ?, updated_at = ?
         WHERE extension_id = ? AND updated_at = ?`,
      )
      .run(
        ownerPid,
        ownerInstanceId,
        ownerGeneration ?? null,
        now,
        now,
        extensionId,
        existing.updatedAt,
      );

    if (stolen.changes > 0) {
      return {
        acquired: true,
        stolen: true,
        ownerPid: existing.ownerPid,
        ownerInstanceId: existing.ownerInstanceId,
        ownerGeneration: existing.ownerGeneration,
      };
    }
  }

  return {
    acquired: false,
    ownerPid: existing.ownerPid,
    ownerInstanceId: existing.ownerInstanceId,
    ownerGeneration: existing.ownerGeneration,
  };
}

export function renewExtensionProcessLock(
  extensionId: string,
  ownerPid: number,
  ownerInstanceId: string,
  ownerGeneration?: string | null,
  d?: Database,
): boolean {
  const db = dbOrDefault(d);
  const now = Date.now();

  const result = db
    .query(
      `UPDATE extension_process_locks
       SET owner_generation = ?, updated_at = ?
       WHERE extension_id = ? AND owner_pid = ? AND owner_instance_id = ?`,
    )
    .run(ownerGeneration ?? null, now, extensionId, ownerPid, ownerInstanceId);

  return result.changes > 0;
}

export function releaseExtensionProcessLock(
  extensionId: string,
  ownerPid: number,
  ownerInstanceId: string,
  d?: Database,
): boolean {
  const db = dbOrDefault(d);
  const result = db
    .query(
      `DELETE FROM extension_process_locks
       WHERE extension_id = ? AND owner_pid = ? AND owner_instance_id = ?`,
    )
    .run(extensionId, ownerPid, ownerInstanceId);
  return result.changes > 0;
}

export function getExtensionProcessLocks(
  staleMs: number = DEFAULT_EXTENSION_LOCK_STALE_MS,
  d?: Database,
): ExtensionProcessLockRow[] {
  const db = dbOrDefault(d);
  const now = Date.now();
  const rows = db
    .query(
      `SELECT
        extension_id AS extensionId,
        owner_pid AS ownerPid,
        owner_instance_id AS ownerInstanceId,
        owner_generation AS ownerGeneration,
        acquired_at AS acquiredAt,
        updated_at AS updatedAt
      FROM extension_process_locks
      ORDER BY extension_id ASC`,
    )
    .all() as Array<{
    extensionId: string;
    ownerPid: number;
    ownerInstanceId: string;
    ownerGeneration: string | null;
    acquiredAt: number;
    updatedAt: number;
  }>;

  return rows.map((row) => ({
    ...row,
    stale: row.updatedAt < now - staleMs,
  }));
}
