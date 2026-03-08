-- Up

PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  provider_session_id TEXT NOT NULL UNIQUE,
  model               TEXT NOT NULL,
  agent               TEXT NOT NULL DEFAULT 'claude',
  purpose             TEXT NOT NULL DEFAULT 'chat',
  parent_session_id   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','completed','failed','interrupted','stalled')),
  title               TEXT,
  summary             TEXT,
  metadata_json       TEXT,
  previous_session_id TEXT,
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_new (
  id,
  workspace_id,
  provider_session_id,
  model,
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
  provider_session_id,
  model,
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
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_provider_session ON sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);

PRAGMA foreign_keys = ON;

-- Down

PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_old (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  provider_session_id TEXT NOT NULL UNIQUE,
  model               TEXT,
  agent               TEXT NOT NULL DEFAULT 'claude',
  purpose             TEXT NOT NULL DEFAULT 'chat',
  parent_session_id   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','completed','failed','interrupted','stalled')),
  title               TEXT,
  summary             TEXT,
  metadata_json       TEXT,
  previous_session_id TEXT,
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_old
SELECT * FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_old RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_provider_session ON sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);

PRAGMA foreign_keys = ON;
