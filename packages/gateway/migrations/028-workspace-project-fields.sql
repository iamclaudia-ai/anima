-- Up

-- Project metadata on workspaces, so a project name, an email domain, a GitHub
-- repo or a Sentry project resolves to one workspace (and its folder). Used by
-- the support desk to route tickets and delegate work. Lists are JSON arrays.
ALTER TABLE workspaces ADD COLUMN description TEXT;
ALTER TABLE workspaces ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspaces ADD COLUMN email_domains TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspaces ADD COLUMN github_repo TEXT;
ALTER TABLE workspaces ADD COLUMN sentry_project TEXT;

-- Down

ALTER TABLE workspaces DROP COLUMN sentry_project;
ALTER TABLE workspaces DROP COLUMN github_repo;
ALTER TABLE workspaces DROP COLUMN email_domains;
ALTER TABLE workspaces DROP COLUMN aliases;
ALTER TABLE workspaces DROP COLUMN description;
