-- Up

-- Gateway-wide singleton locks for extension host processes.
-- Ensures one process per extension ID across concurrent gateway instances.
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

-- Down

DROP INDEX IF EXISTS idx_extension_process_locks_updated;
DROP TABLE IF EXISTS extension_process_locks;
