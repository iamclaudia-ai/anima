-- Up

-- Support desk (extensions/support). A ticket is one problem; reports are the
-- people and alerts that told us about it; links point at the GitHub issues,
-- PRs, sessions and Sentry issues that work on it; activity is its timeline.
-- GitHub stays the source of truth for code work: links only mirror state.
CREATE TABLE support_tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  title        TEXT NOT NULL,
  summary      TEXT,
  status       TEXT NOT NULL DEFAULT 'new'
               CHECK(status IN ('new', 'triaged', 'in_progress', 'waiting', 'fixed', 'closed')),
  priority     TEXT NOT NULL DEFAULT 'normal'
               CHECK(priority IN ('urgent', 'high', 'normal', 'low')),
  -- Came from a trusted source (verified mail from Michael, Sentry, GitHub, or
  -- created by Michael or Claudia). Only trusted or approved tickets delegate.
  trusted      INTEGER NOT NULL DEFAULT 0,
  approved     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  closed_at    TEXT
);

CREATE INDEX idx_support_tickets_status ON support_tickets(status, updated_at);

CREATE TABLE support_reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id      INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK(source IN ('email', 'sentry', 'forum', 'github', 'manual')),
  -- Zoho message id, Sentry issue id, forum message id, …
  external_id    TEXT,
  reporter_name  TEXT,
  reporter_email TEXT,
  url            TEXT,
  summary        TEXT,
  trusted        INTEGER NOT NULL DEFAULT 0,
  received_at    TEXT NOT NULL,
  replied_at     TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE(ticket_id, source, external_id)
);

CREATE INDEX idx_support_reports_external ON support_reports(source, external_id);

CREATE TABLE support_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK(kind IN ('issue', 'pr', 'session', 'sentry', 'other')),
  -- "owner/repo#12" for issues and PRs, a session id, a Sentry short id, …
  ref        TEXT NOT NULL,
  url        TEXT,
  title      TEXT,
  state      TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(ticket_id, kind, ref)
);

CREATE INDEX idx_support_links_ref ON support_links(kind, ref);

CREATE TABLE support_activity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  kind      TEXT NOT NULL,
  note      TEXT
);

CREATE INDEX idx_support_activity_ticket ON support_activity(ticket_id, at);
CREATE INDEX idx_support_activity_kind ON support_activity(kind, at);

-- Down

DROP INDEX idx_support_activity_kind;
DROP INDEX idx_support_activity_ticket;
DROP TABLE support_activity;
DROP INDEX idx_support_links_ref;
DROP TABLE support_links;
DROP INDEX idx_support_reports_external;
DROP TABLE support_reports;
DROP INDEX idx_support_tickets_status;
DROP TABLE support_tickets;
