-- Up
CREATE TABLE workspaces (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  cwd               TEXT NOT NULL UNIQUE,
  active_session_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Down
DROP TABLE IF EXISTS workspaces;
