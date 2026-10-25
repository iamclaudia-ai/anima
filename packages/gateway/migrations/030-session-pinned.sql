-- Up

-- A session Michael pinned in the ACTIVE pane. Pinned sessions sort ahead of
-- the rest, each group still newest-created first, so pinning moves a row
-- once and never again. Only the queue reads it: a resolved session leaves
-- the queue pinned or not, and comes back pinned if it is reopened.
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- Down

ALTER TABLE sessions DROP COLUMN pinned;
