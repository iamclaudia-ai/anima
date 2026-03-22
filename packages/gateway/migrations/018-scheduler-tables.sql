-- Up

CREATE TABLE scheduler_tasks (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  description            TEXT,
  type                   TEXT NOT NULL CHECK(type IN ('once', 'interval', 'cron')),
  fire_at                TEXT NOT NULL,
  interval_seconds       INTEGER,
  cron_expr              TEXT,
  action_type            TEXT NOT NULL CHECK(action_type IN ('emit', 'extension_call', 'notification', 'exec')),
  action_target          TEXT NOT NULL,
  action_payload         TEXT,
  missed_policy          TEXT NOT NULL DEFAULT 'fire_once' CHECK(missed_policy IN ('fire_once', 'skip', 'fire_all')),
  concurrency            TEXT NOT NULL DEFAULT 'skip_if_running' CHECK(concurrency IN ('allow', 'skip_if_running', 'cancel_previous')),
  start_deadline_seconds INTEGER,
  enabled                INTEGER NOT NULL DEFAULT 1,
  tags                   TEXT,
  created_at             TEXT NOT NULL,
  fired_count            INTEGER NOT NULL DEFAULT 0,
  last_fired_at          TEXT,
  keep_history           INTEGER NOT NULL DEFAULT 50
);

CREATE INDEX idx_sched_tasks_fire ON scheduler_tasks(fire_at) WHERE enabled = 1;

CREATE TABLE scheduler_task_executions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
  fired_at     TEXT NOT NULL,
  completed_at TEXT,
  status       TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped', 'cancelled')),
  duration_ms  INTEGER,
  error        TEXT,
  output       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sched_exec_task ON scheduler_task_executions(task_id, fired_at DESC);

-- Down

DROP INDEX IF EXISTS idx_sched_exec_task;
DROP INDEX IF EXISTS idx_sched_tasks_fire;
DROP TABLE IF EXISTS scheduler_task_executions;
DROP TABLE IF EXISTS scheduler_tasks;
