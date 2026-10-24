-- Up

-- Inbound webhook inbox, owned by the webhooks extension. A delivery is
-- written here before the HTTP response goes out, so nothing a sender has
-- been told was accepted can be lost to a crash or a restart.
CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  hook            TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  content_type    TEXT,
  headers         TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  delivered_at    TEXT
);

CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries(hook, received_at);

-- Signing secrets a sender hands over in-band (Zoho Mail sends `x-hook-secret`
-- once, on the first request), kept so later deliveries can be verified.
CREATE TABLE webhook_signing_secrets (
  hook       TEXT PRIMARY KEY,
  secret     TEXT NOT NULL,
  learned_at TEXT NOT NULL
);

-- Down

DROP TABLE webhook_signing_secrets;
DROP INDEX idx_webhook_deliveries_hook;
DROP INDEX idx_webhook_deliveries_due;
DROP TABLE webhook_deliveries;
