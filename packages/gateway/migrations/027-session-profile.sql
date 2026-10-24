-- Up

-- The permission profile a session was created with (yolo, auto, mail, …).
-- Written once at creation and never changed, then sent to agent-host with
-- every create and prompt, so a session resumed after a restart or an idle
-- reap comes back with the same powers it started with. NULL rows predate
-- profiles; every one of them was created in yolo mode, and reads as yolo.
ALTER TABLE sessions ADD COLUMN profile TEXT;

-- Down

ALTER TABLE sessions DROP COLUMN profile;
