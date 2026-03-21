-- Up
ALTER TABLE workspaces ADD COLUMN general INTEGER NOT NULL DEFAULT 0;

-- Down
PRAGMA foreign_keys=OFF;

CREATE TABLE workspaces__rollback (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  cwd               TEXT NOT NULL UNIQUE,
  active_session_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO workspaces__rollback (id, name, cwd, active_session_id, created_at, updated_at)
SELECT id, name, cwd, active_session_id, created_at, updated_at
FROM workspaces;

DROP TABLE workspaces;
ALTER TABLE workspaces__rollback RENAME TO workspaces;

PRAGMA foreign_keys=ON;
