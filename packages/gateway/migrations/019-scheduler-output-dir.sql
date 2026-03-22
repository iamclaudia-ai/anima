-- Up

ALTER TABLE scheduler_tasks ADD COLUMN output_dir TEXT;

-- Down

-- SQLite <3.35 doesn't support DROP COLUMN; column is nullable so harmless to leave
