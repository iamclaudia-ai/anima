-- Up
--
-- Two status axes instead of one.
--
-- `runtime_status` answers "what is the agent doing right now" and is written
-- by the lifecycle path as events arrive. It gains `awaiting_input` and
-- `awaiting_approval`, the two states that were previously invisible: a
-- session blocked on a modal prompt in its tmux pane looked exactly like an
-- idle one, which is the whole of #67's complaint.
--
-- `disposition` answers "where does this work stand" and is only ever written
-- by a human. It is deliberately NOT the same column as `status`: `status`
-- records whether the row still has a transcript on disk (the reconciler
-- archives rows whose JSONL Claude Code deleted), while `disposition` records
-- intent. Both hide a row from the default list, for entirely different
-- reasons, and conflating them is what made `runtime_status` unusable in the
-- nav in the first place.
--
-- SQLite cannot alter a CHECK constraint, so widening `runtime_status` means a
-- table rebuild — migrations 014 and 015 are the worked examples this follows.

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
  runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','awaiting_input','awaiting_approval','completed','failed','interrupted','stalled')),
  disposition         TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','needs_review','blocked','snoozed','resolved','archived')),
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
-- The nav's default list is "this workspace, chat sessions, not resolved or
-- archived, newest first" — this is that query's covering index.
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_disposition ON sessions(workspace_id, disposition);

PRAGMA foreign_keys = ON;

-- Down

PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_old (
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

-- The two new runtime states have no pre-024 equivalent, so they collapse to
-- the state they are closest to: a session waiting on a human is not running.
INSERT INTO sessions_old (
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
  CASE WHEN runtime_status IN ('awaiting_input','awaiting_approval') THEN 'idle' ELSE runtime_status END,
  title,
  summary,
  metadata_json,
  previous_session_id,
  last_activity,
  created_at,
  updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_old RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_provider_session ON sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);

PRAGMA foreign_keys = ON;
