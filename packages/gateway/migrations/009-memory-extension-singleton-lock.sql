-- Up

-- Singleton lock for the memory extension process.
-- Exactly one process should hold this lock at a time.
CREATE TABLE IF NOT EXISTS memory_extension_locks (
  lock_id TEXT PRIMARY KEY, -- always 'memory-extension'
  owner_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_extension_locks_updated
ON memory_extension_locks(updated_at);

-- Down
DROP INDEX IF EXISTS idx_memory_extension_locks_updated;
DROP TABLE IF EXISTS memory_extension_locks;
