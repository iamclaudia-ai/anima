-- Up
PRAGMA foreign_keys = OFF;

-- Some existing installs have migration history with no legacy sessions table.
-- Create a compatible empty legacy table so the copy step remains safe/idempotent.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  cc_session_id       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  title               TEXT,
  summary             TEXT,
  previous_session_id TEXT REFERENCES sessions(id),
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions_new (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  cc_session_id       TEXT NOT NULL,
  agent               TEXT NOT NULL DEFAULT 'claude',
  purpose             TEXT NOT NULL DEFAULT 'chat',
  parent_session_id   TEXT REFERENCES sessions_new(id),
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','completed','failed','interrupted','stalled')),
  title               TEXT,
  summary             TEXT,
  metadata_json       TEXT,
  previous_session_id TEXT REFERENCES sessions_new(id),
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_new (
  id,
  workspace_id,
  cc_session_id,
  agent,
  purpose,
  parent_session_id,
  status,
  runtime_status,
  title,
  summary,
  metadata_json,
  previous_session_id,
  last_activity,
  created_at,
  updated_at
)
SELECT
  id,
  workspace_id,
  cc_session_id,
  'claude',
  'chat',
  NULL,
  status,
  CASE
    WHEN status = 'active' THEN 'idle'
    ELSE 'completed'
  END,
  title,
  summary,
  NULL,
  previous_session_id,
  last_activity,
  created_at,
  COALESCE(last_activity, created_at, datetime('now'))
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_cc ON sessions(cc_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);

PRAGMA foreign_keys = ON;

-- Down
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS sessions_old (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  cc_session_id       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  title               TEXT,
  summary             TEXT,
  previous_session_id TEXT REFERENCES sessions_old(id),
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_old (
  id,
  workspace_id,
  cc_session_id,
  status,
  title,
  summary,
  previous_session_id,
  last_activity,
  created_at
)
SELECT
  id,
  workspace_id,
  cc_session_id,
  status,
  title,
  summary,
  previous_session_id,
  last_activity,
  created_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_old RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_cc ON sessions(cc_session_id);

PRAGMA foreign_keys = ON;
