-- Up

-- Messages the mail extension has announced (`mail.received`), so the webhook
-- and the reconcile backstop never announce the same message twice. Zoho is
-- the source of truth for everything else (read state, folder, body).
CREATE TABLE mail_messages (
  message_id    TEXT PRIMARY KEY,
  folder_id     TEXT NOT NULL,
  thread_id     TEXT,
  from_address  TEXT NOT NULL,
  sender        TEXT,
  subject       TEXT,
  received_at   TEXT NOT NULL,
  source        TEXT NOT NULL CHECK(source IN ('webhook', 'reconcile')),
  first_seen_at TEXT NOT NULL
);

CREATE INDEX idx_mail_messages_received ON mail_messages(received_at);

-- Down

DROP INDEX idx_mail_messages_received;
DROP TABLE mail_messages;
