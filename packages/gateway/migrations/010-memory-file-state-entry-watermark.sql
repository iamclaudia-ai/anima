-- Up

-- Track the last fully committed transcript entry id per source file.
-- This allows crash recovery rollback to be exact even when multiple entries
-- share the same timestamp.
ALTER TABLE memory_file_states ADD COLUMN last_committed_entry_id INTEGER;

UPDATE memory_file_states
SET last_committed_entry_id = (
  SELECT max(e.id)
  FROM memory_transcript_entries e
  WHERE e.source_file = memory_file_states.file_path
);

-- Down
CREATE TABLE memory_file_states_old (
  file_path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','ingesting')),
  last_modified INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  last_processed_offset INTEGER NOT NULL DEFAULT 0,
  last_entry_timestamp TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO memory_file_states_old
  (file_path, source, status, last_modified, file_size, last_processed_offset, last_entry_timestamp, created_at, updated_at)
SELECT
  file_path, source, status, last_modified, file_size, last_processed_offset, last_entry_timestamp, created_at, updated_at
FROM memory_file_states;

DROP TABLE memory_file_states;
ALTER TABLE memory_file_states_old RENAME TO memory_file_states;
