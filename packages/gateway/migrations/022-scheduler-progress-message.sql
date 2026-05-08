-- Up

ALTER TABLE scheduler_task_executions ADD COLUMN progress_message TEXT;

-- Down

-- SQLite <3.35 doesn't support DROP COLUMN; column is nullable so harmless to leave
