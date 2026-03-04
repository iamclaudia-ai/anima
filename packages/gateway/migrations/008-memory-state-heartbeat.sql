-- Up

-- Add last_heartbeat to memory_state_machines.
-- We rebuild the table instead of ALTER TABLE ADD COLUMN so this remains
-- safe even on databases where the column was already manually added.

CREATE TABLE memory_state_machines_new (
  machine_id      TEXT PRIMARY KEY,
  state_json      TEXT NOT NULL,
  process_id      INTEGER NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat  TEXT
);

INSERT INTO memory_state_machines_new (machine_id, state_json, process_id, updated_at, last_heartbeat)
SELECT machine_id, state_json, process_id, updated_at, NULL
FROM memory_state_machines;

DROP TABLE memory_state_machines;
ALTER TABLE memory_state_machines_new RENAME TO memory_state_machines;

CREATE INDEX IF NOT EXISTS idx_state_machines_updated
ON memory_state_machines(updated_at);

-- Down

CREATE TABLE memory_state_machines_old (
  machine_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  process_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO memory_state_machines_old (machine_id, state_json, process_id, updated_at)
SELECT machine_id, state_json, process_id, updated_at
FROM memory_state_machines;

DROP TABLE memory_state_machines;
ALTER TABLE memory_state_machines_old RENAME TO memory_state_machines;

CREATE INDEX IF NOT EXISTS idx_state_machines_updated
ON memory_state_machines(updated_at);
