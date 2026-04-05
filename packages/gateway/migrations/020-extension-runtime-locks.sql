-- Up

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

CREATE INDEX IF NOT EXISTS idx_extension_runtime_locks_updated
ON extension_runtime_locks(updated_at);

-- Down

DROP INDEX IF EXISTS idx_extension_runtime_locks_updated;
DROP TABLE IF EXISTS extension_runtime_locks;
