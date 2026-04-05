-- Up

DROP INDEX IF EXISTS idx_memory_extension_locks_updated;
DROP TABLE IF EXISTS memory_extension_locks;

-- Down

CREATE TABLE IF NOT EXISTS memory_extension_locks (
  lock_id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_extension_locks_updated
ON memory_extension_locks(updated_at);
