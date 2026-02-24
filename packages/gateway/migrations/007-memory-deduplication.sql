-- Migration 008: Memory Extension Deduplication & State Management
-- Prevents duplicate conversations and adds XState persistence

-- =============================================================================
-- PART 1: State Machine Persistence
-- =============================================================================

-- Store XState machine snapshots as JSON for crash recovery and state persistence
CREATE TABLE IF NOT EXISTS memory_state_machines (
  machine_id TEXT PRIMARY KEY,      -- 'extension' or 'ingest:{sourceFile}'
  state_json TEXT NOT NULL,         -- JSON.stringify(machine.getSnapshot())
  process_id INTEGER NOT NULL,      -- PID for detecting stale processes
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_state_machines_updated
ON memory_state_machines(updated_at);

-- =============================================================================
-- PART 2: File-Level Locks
-- =============================================================================

-- Advisory locks for file-level operations (ingesting, rebuilding conversations)
-- Prevents concurrent operations on the same file
CREATE TABLE IF NOT EXISTS memory_file_locks (
  source_file TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('ingesting', 'rebuilding')),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_by_pid INTEGER NOT NULL,
  locked_by_machine TEXT  -- machine_id from memory_state_machines
);

CREATE INDEX IF NOT EXISTS idx_file_locks_locked_at
ON memory_file_locks(locked_at);

-- =============================================================================
-- PART 3: Deduplication - Mark Existing Duplicates
-- =============================================================================

-- Find and mark duplicate conversations (keep oldest, mark others as skipped)
-- This handles any duplicates created before this migration
UPDATE memory_conversations
SET
  status = 'skipped',
  summary = 'Duplicate conversation (merged during deduplication migration)',
  processed_at = datetime('now')
WHERE id NOT IN (
  SELECT MIN(id)
  FROM memory_conversations
  GROUP BY source_file, first_message_at
)
AND status NOT IN ('archived', 'skipped');

-- =============================================================================
-- PART 4: Add UNIQUE Constraint
-- =============================================================================

-- Partial unique index prevents active duplicate conversations
-- Allows archived/skipped duplicates (for re-processing scenarios)
-- This enforces uniqueness at the database level, preventing race conditions
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_unique_timerange
ON memory_conversations(source_file, first_message_at)
WHERE status NOT IN ('archived', 'skipped');

-- =============================================================================
-- PART 5: Cleanup Functions (via triggers)
-- =============================================================================

-- Note: SQLite doesn't support stored procedures or scheduled jobs.
-- Stale lock cleanup will be handled in the extension's startup recovery logic.
-- However, we can document the cleanup queries here for reference:

-- Clean up stale file locks (older than 5 minutes):
-- DELETE FROM memory_file_locks
-- WHERE datetime(locked_at, '+5 minutes') < datetime('now');

-- Clean up stale state machine entries (older than 1 hour):
-- DELETE FROM memory_state_machines
-- WHERE machine_id LIKE 'ingest:%'
--   AND datetime(updated_at, '+1 hour') < datetime('now');

-- Down

DROP INDEX IF EXISTS idx_conversations_unique_timerange;
DROP INDEX IF EXISTS idx_file_locks_locked_at;
DROP TABLE IF EXISTS memory_file_locks;
DROP INDEX IF EXISTS idx_state_machines_updated;
DROP TABLE IF EXISTS memory_state_machines;
