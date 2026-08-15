-- Up

-- `general` and `pinned` are declared here rather than in a later migration.
--
-- They arrived in `016-workspaces-general-flag.sql`, which collided with
-- `016-memory-fts.sql` — `_migrations.id` is a primary key, so on any database
-- built from scratch the second id-16 file aborted the run and everything from
-- 16 onward was lost. On the one live database `memory-fts` won that race, so
-- the flag migration never ran at all; the columns exist there only because
-- `ensureSessionTable()` adds them defensively at runtime, which is what hid
-- the breakage for five months. `pinned` never had a migration in the first
-- place, for the same reason.
--
-- Folding both into the initial schema is correct for a fresh database and a
-- no-op for the live one, which already has the columns and already recorded
-- migration 1 as applied.
CREATE TABLE workspaces (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  cwd               TEXT NOT NULL UNIQUE,
  general           INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  active_session_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Down
DROP TABLE IF EXISTS workspaces;
