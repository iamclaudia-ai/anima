-- Up

ALTER TABLE sessions ADD COLUMN model TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);

-- Down

DROP INDEX IF EXISTS idx_sessions_model;
