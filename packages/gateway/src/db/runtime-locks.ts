import type { Database } from "bun:sqlite";
import { getDb } from "./index";

type ExtensionRuntimeLockType = "singleton" | "processing" | "lease";
const DEFAULT_RUNTIME_LOCK_STALE_MS = 3 * 60 * 1000;

export interface ExtensionRuntimeLockRow {
  extensionId: string;
  lockType: string;
  resourceKey: string;
  holderPid: number | null;
  holderInstanceId: string;
  acquiredAt: number;
  updatedAt: number;
  staleAfterMs: number;
  metadata: Record<string, unknown> | null;
  stale: boolean;
}

export interface AcquireRuntimeLockParams {
  extensionId: string;
  lockType: ExtensionRuntimeLockType;
  resourceKey?: string;
  holderPid?: number | null;
  holderInstanceId: string;
  staleAfterMs?: number;
  metadata?: Record<string, unknown>;
}

export interface AcquireRuntimeLockResult {
  acquired: boolean;
  stolen?: boolean;
  alreadyOwned?: boolean;
  lock: ExtensionRuntimeLockRow | null;
  previousOwner?: {
    holderPid: number | null;
    holderInstanceId: string;
  };
}

function dbOrDefault(d?: Database): Database {
  return d ?? getDb();
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getLockRow(
  extensionId: string,
  lockType: string,
  resourceKey: string,
  d?: Database,
): ExtensionRuntimeLockRow | null {
  const db = dbOrDefault(d);
  const row = db
    .query(
      `SELECT
        extension_id AS extensionId,
        lock_type AS lockType,
        resource_key AS resourceKey,
        holder_pid AS holderPid,
        holder_instance_id AS holderInstanceId,
        acquired_at AS acquiredAt,
        updated_at AS updatedAt,
        stale_after_ms AS staleAfterMs,
        metadata_json AS metadataJson
      FROM extension_runtime_locks
      WHERE extension_id = ? AND lock_type = ? AND resource_key = ?`,
    )
    .get(extensionId, lockType, resourceKey) as {
    extensionId: string;
    lockType: string;
    resourceKey: string;
    holderPid: number | null;
    holderInstanceId: string;
    acquiredAt: number;
    updatedAt: number;
    staleAfterMs: number;
    metadataJson: string | null;
  } | null;

  if (!row) return null;

  return {
    extensionId: row.extensionId,
    lockType: row.lockType,
    resourceKey: row.resourceKey,
    holderPid: row.holderPid,
    holderInstanceId: row.holderInstanceId,
    acquiredAt: row.acquiredAt,
    updatedAt: row.updatedAt,
    staleAfterMs: row.staleAfterMs,
    metadata: parseMetadata(row.metadataJson),
    stale: row.updatedAt <= Date.now() - row.staleAfterMs,
  };
}

export function acquireExtensionRuntimeLock(
  params: AcquireRuntimeLockParams,
  d?: Database,
): AcquireRuntimeLockResult {
  const db = dbOrDefault(d);
  const now = Date.now();
  const resourceKey = params.resourceKey ?? "__default__";
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_RUNTIME_LOCK_STALE_MS;
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;

  const insert = db
    .query(
      `INSERT INTO extension_runtime_locks
        (extension_id, lock_type, resource_key, holder_pid, holder_instance_id, acquired_at, updated_at, stale_after_ms, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(extension_id, lock_type, resource_key) DO NOTHING`,
    )
    .run(
      params.extensionId,
      params.lockType,
      resourceKey,
      params.holderPid ?? null,
      params.holderInstanceId,
      now,
      now,
      staleAfterMs,
      metadataJson,
    );

  if (insert.changes > 0) {
    return {
      acquired: true,
      lock: getLockRow(params.extensionId, params.lockType, resourceKey, db),
    };
  }

  const existing = getLockRow(params.extensionId, params.lockType, resourceKey, db);
  if (!existing) {
    return { acquired: false, lock: null };
  }

  if (
    existing.holderInstanceId === params.holderInstanceId &&
    existing.holderPid === (params.holderPid ?? null)
  ) {
    db.query(
      `UPDATE extension_runtime_locks
       SET updated_at = ?, stale_after_ms = ?, metadata_json = ?
       WHERE extension_id = ? AND lock_type = ? AND resource_key = ?`,
    ).run(now, staleAfterMs, metadataJson, params.extensionId, params.lockType, resourceKey);
    return {
      acquired: true,
      alreadyOwned: true,
      lock: getLockRow(params.extensionId, params.lockType, resourceKey, db),
    };
  }

  if (existing.stale) {
    const stolen = db
      .query(
        `UPDATE extension_runtime_locks
         SET holder_pid = ?, holder_instance_id = ?, acquired_at = ?, updated_at = ?, stale_after_ms = ?, metadata_json = ?
         WHERE extension_id = ? AND lock_type = ? AND resource_key = ? AND updated_at = ?`,
      )
      .run(
        params.holderPid ?? null,
        params.holderInstanceId,
        now,
        now,
        staleAfterMs,
        metadataJson,
        params.extensionId,
        params.lockType,
        resourceKey,
        existing.updatedAt,
      );

    if (stolen.changes > 0) {
      return {
        acquired: true,
        stolen: true,
        previousOwner: {
          holderPid: existing.holderPid,
          holderInstanceId: existing.holderInstanceId,
        },
        lock: getLockRow(params.extensionId, params.lockType, resourceKey, db),
      };
    }
  }

  return { acquired: false, lock: existing };
}

export function renewExtensionRuntimeLock(
  params: {
    extensionId: string;
    lockType: string;
    resourceKey?: string;
    holderPid?: number | null;
    holderInstanceId: string;
    staleAfterMs?: number;
    metadata?: Record<string, unknown>;
  },
  d?: Database,
): boolean {
  const db = dbOrDefault(d);
  const resourceKey = params.resourceKey ?? "__default__";
  const result = db
    .query(
      `UPDATE extension_runtime_locks
       SET updated_at = ?, stale_after_ms = ?, metadata_json = ?
       WHERE extension_id = ? AND lock_type = ? AND resource_key = ? AND holder_instance_id = ? AND holder_pid IS ?`,
    )
    .run(
      Date.now(),
      params.staleAfterMs ?? DEFAULT_RUNTIME_LOCK_STALE_MS,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.extensionId,
      params.lockType,
      resourceKey,
      params.holderInstanceId,
      params.holderPid ?? null,
    );
  return result.changes > 0;
}

export function releaseExtensionRuntimeLock(
  params: {
    extensionId: string;
    lockType: string;
    resourceKey?: string;
    holderPid?: number | null;
    holderInstanceId: string;
  },
  d?: Database,
): boolean {
  const db = dbOrDefault(d);
  const result = db
    .query(
      `DELETE FROM extension_runtime_locks
       WHERE extension_id = ? AND lock_type = ? AND resource_key = ? AND holder_instance_id = ? AND holder_pid IS ?`,
    )
    .run(
      params.extensionId,
      params.lockType,
      params.resourceKey ?? "__default__",
      params.holderInstanceId,
      params.holderPid ?? null,
    );
  return result.changes > 0;
}

export function getExtensionRuntimeLocks(
  extensionId?: string,
  d?: Database,
): ExtensionRuntimeLockRow[] {
  const db = dbOrDefault(d);
  const rows = extensionId
    ? (db
        .query(
          `SELECT
            extension_id AS extensionId,
            lock_type AS lockType,
            resource_key AS resourceKey,
            holder_pid AS holderPid,
            holder_instance_id AS holderInstanceId,
            acquired_at AS acquiredAt,
            updated_at AS updatedAt,
            stale_after_ms AS staleAfterMs,
            metadata_json AS metadataJson
          FROM extension_runtime_locks
          WHERE extension_id = ?
          ORDER BY extension_id, lock_type, resource_key`,
        )
        .all(extensionId) as Array<{
        extensionId: string;
        lockType: string;
        resourceKey: string;
        holderPid: number | null;
        holderInstanceId: string;
        acquiredAt: number;
        updatedAt: number;
        staleAfterMs: number;
        metadataJson: string | null;
      }>)
    : (db
        .query(
          `SELECT
            extension_id AS extensionId,
            lock_type AS lockType,
            resource_key AS resourceKey,
            holder_pid AS holderPid,
            holder_instance_id AS holderInstanceId,
            acquired_at AS acquiredAt,
            updated_at AS updatedAt,
            stale_after_ms AS staleAfterMs,
            metadata_json AS metadataJson
          FROM extension_runtime_locks
          ORDER BY extension_id, lock_type, resource_key`,
        )
        .all() as Array<{
        extensionId: string;
        lockType: string;
        resourceKey: string;
        holderPid: number | null;
        holderInstanceId: string;
        acquiredAt: number;
        updatedAt: number;
        staleAfterMs: number;
        metadataJson: string | null;
      }>);

  return rows.map((row) => ({
    extensionId: row.extensionId,
    lockType: row.lockType,
    resourceKey: row.resourceKey,
    holderPid: row.holderPid,
    holderInstanceId: row.holderInstanceId,
    acquiredAt: row.acquiredAt,
    updatedAt: row.updatedAt,
    staleAfterMs: row.staleAfterMs,
    metadata: parseMetadata(row.metadataJson),
    stale: row.updatedAt <= Date.now() - row.staleAfterMs,
  }));
}
