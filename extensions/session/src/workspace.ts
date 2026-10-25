/**
 * Workspace CRUD
 *
 * Owns the workspace table in ~/.anima/anima.db.
 * Opens its own SQLite connection (WAL mode) for concurrent access
 * with the gateway process.
 *
 * Note: activeSessionId removed — sessions are read from filesystem.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { generateWorkspaceId, createLogger } from "@anima/shared";
import { resolveProjectDir } from "./claude-projects";

const log = createLogger("Workspace", join(homedir(), ".anima", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  general: boolean;
  /** User-pinned — sorts to the top of the workspace list with a visual badge. */
  pinned: boolean;
  cwdDisplay: string; // Normalized path with ~ for display
  /** One line about the project, for humans and for routing. */
  description: string | null;
  /** Other names the project goes by ("nutwords", "the nuthouse"). Lowercase. */
  aliases: string[];
  /** Email domains that belong to the project ("nutwords.com"). Lowercase. */
  emailDomains: string[];
  /** "owner/repo" on GitHub. */
  githubRepo: string | null;
  /** Sentry project slugs (a project can have several, e.g. API and web). Lowercase. */
  sentryProjects: string[];
  createdAt: string;
  updatedAt: string;
}

/** Project fields settable with `updateWorkspaceProject`. */
export interface WorkspaceProjectFields {
  name?: string;
  description?: string | null;
  aliases?: string[];
  emailDomains?: string[];
  githubRepo?: string | null;
  sentryProjects?: string[];
}

/** Raw row from SQLite (snake_case) */
interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  general: number;
  pinned: number;
  active_session_id: string | null; // Still in schema but we ignore it
  description: string | null;
  aliases: string;
  email_domains: string;
  github_repo: string | null;
  sentry_projects: string;
  created_at: string;
  updated_at: string;
}

/**
 * Normalize path for display by replacing home directory with ~
 */
function normalizePathForDisplay(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

function parseList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Convert DB row to API type */
function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd, // Keep full path for operations
    general: row.general === 1,
    pinned: row.pinned === 1,
    cwdDisplay: normalizePathForDisplay(row.cwd), // Normalized for display
    description: row.description ?? null,
    aliases: parseList(row.aliases),
    emailDomains: parseList(row.email_domains),
    githubRepo: row.github_repo ?? null,
    sentryProjects: parseList(row.sentry_projects),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Database ─────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  const claudiaDir = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
  if (!existsSync(claudiaDir)) {
    mkdirSync(claudiaDir, { recursive: true });
  }

  const dbPath = join(claudiaDir, "anima.db");
  db = new Database(dbPath);

  // WAL mode for concurrent access with gateway
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  // Ensure workspaces table exists (gateway migrations create it,
  // but we need this for standalone extension testing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE,
      general INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      active_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const columns = db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "general")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN general INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "pinned")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  // Project fields (gateway migration 028); added here for standalone tests.
  const projectColumns: Array<[string, string]> = [
    ["description", "TEXT"],
    ["aliases", "TEXT NOT NULL DEFAULT '[]'"],
    ["email_domains", "TEXT NOT NULL DEFAULT '[]'"],
    ["github_repo", "TEXT"],
    ["sentry_projects", "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [name, type] of projectColumns) {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${name} ${type}`);
    }
  }

  log.info("Opened workspace database", { path: dbPath });
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Get the most recent JSONL file timestamp for a workspace.
 * Returns ISO string or null if no sessions found.
 */
function getMostRecentSessionTimestamp(cwd: string): string | null {
  const projectDir = resolveProjectDir(cwd);
  if (!projectDir) return null;

  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;

    let mostRecent = 0;
    for (const file of files) {
      try {
        const stats = statSync(join(projectDir, file));
        if (stats.mtimeMs > mostRecent) {
          mostRecent = stats.mtimeMs;
        }
      } catch {
        // skip
      }
    }

    return mostRecent > 0 ? new Date(mostRecent).toISOString() : null;
  } catch {
    return null;
  }
}

// ── CRUD ─────────────────────────────────────────────────────

export function listWorkspaces(): Workspace[] {
  const rows = getDb()
    .query("SELECT * FROM workspaces ORDER BY updated_at DESC")
    .all() as WorkspaceRow[];

  // Enrich with most recent session timestamp from filesystem
  const workspaces = rows.map((row) => {
    const workspace = toWorkspace(row);
    const recentTimestamp = getMostRecentSessionTimestamp(row.cwd);
    // Use the most recent session timestamp if available, otherwise fall back to DB updated_at
    if (recentTimestamp) {
      workspace.updatedAt = recentTimestamp;
    }
    return workspace;
  });

  // Pinned workspaces float to the top; within each group, sort by updatedAt
  // descending (most recent first).
  return workspaces.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * Pin or unpin a workspace. Pinned workspaces sort to the top of
 * `listWorkspaces()` regardless of last-activity time.
 */
export function setWorkspacePinned(id: string, pinned: boolean): Workspace | null {
  const result = getDb()
    .query("UPDATE workspaces SET pinned = ? WHERE id = ?")
    .run(pinned ? 1 : 0, id);
  if (result.changes === 0) return null;
  return getWorkspace(id);
}

export function getWorkspace(id: string): Workspace | null {
  const row = getDb().query("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

export function getWorkspaceByCwd(cwd: string): Workspace | null {
  const row = getDb()
    .query("SELECT * FROM workspaces WHERE cwd = ?")
    .get(cwd) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

export function createWorkspace(params: {
  name: string;
  cwd: string;
  general?: boolean;
}): Workspace {
  const id = generateWorkspaceId();
  getDb()
    .query("INSERT INTO workspaces (id, name, cwd, general) VALUES (?, ?, ?, ?)")
    .run(id, params.name, params.cwd, params.general ? 1 : 0);

  return getWorkspace(id)!;
}

export function getOrCreateWorkspace(
  cwd: string,
  name?: string,
  general?: boolean,
): { workspace: Workspace; created: boolean } {
  // Expand ~ to home directory
  let expandedCwd = cwd;
  if (cwd.startsWith("~")) {
    expandedCwd = join(homedir(), cwd.slice(1));
  }

  const existing = getWorkspaceByCwd(expandedCwd);
  if (existing) {
    return { workspace: existing, created: false };
  }

  // Create directory tree if it doesn't exist
  if (!existsSync(expandedCwd)) {
    try {
      mkdirSync(expandedCwd, { recursive: true });
      log.info("Created workspace directory", { cwd: expandedCwd });
    } catch (error) {
      log.error("Failed to create workspace directory", {
        cwd: expandedCwd,
        error: String(error),
      });
      throw new Error(`Failed to create directory: ${expandedCwd}`);
    }
  }

  // Verify it's a directory
  try {
    const stats = statSync(expandedCwd);
    if (!stats.isDirectory()) {
      throw new Error(`Path exists but is not a directory: ${expandedCwd}`);
    }
  } catch (error) {
    log.error("Failed to verify workspace directory", {
      cwd: expandedCwd,
      error: String(error),
    });
    throw error;
  }

  // Derive name from last path segment if not provided
  const derivedName = name || basename(expandedCwd);
  const workspace = createWorkspace({ name: derivedName, cwd: expandedCwd, general });
  return { workspace, created: true };
}

export function deleteWorkspace(cwd: string): boolean {
  const existing = getWorkspaceByCwd(cwd);
  if (!existing) return false;

  getDb().query("DELETE FROM workspaces WHERE cwd = ?").run(cwd);
  log.info("Deleted workspace", { cwd, id: existing.id });
  return true;
}

// ── Project fields ───────────────────────────────────────────

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

/** Set a workspace's project fields. Omitted fields are left alone; null clears. */
export function updateWorkspaceProject(
  id: string,
  fields: WorkspaceProjectFields,
): Workspace | null {
  const sets: string[] = [];
  const args: Array<string | null> = [];
  const set = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (fields.name !== undefined) set("name", fields.name.trim());
  if (fields.description !== undefined) set("description", fields.description?.trim() || null);
  if (fields.aliases !== undefined) set("aliases", JSON.stringify(normalizeList(fields.aliases)));
  if (fields.emailDomains !== undefined) {
    set("email_domains", JSON.stringify(normalizeList(fields.emailDomains)));
  }
  if (fields.githubRepo !== undefined) set("github_repo", fields.githubRepo?.trim() || null);
  if (fields.sentryProjects !== undefined) {
    set("sentry_projects", JSON.stringify(normalizeList(fields.sentryProjects)));
  }
  if (sets.length === 0) return getWorkspace(id);
  sets.push("updated_at = datetime('now')");
  const result = getDb()
    .query(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args, id);
  return result.changes === 0 ? null : getWorkspace(id);
}

/** "owner/repo" from a GitHub remote URL (https or ssh), or null. */
export function parseGithubRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The workspace's GitHub repo from its git `origin` remote, or null. */
export function detectGithubRepo(cwd: string): string | null {
  const result = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  return parseGithubRemote(result.stdout.toString());
}

export interface WorkspaceQuery {
  /** Name or alias, case-insensitive. */
  name?: string;
  /** An email address or a bare domain; subdomains match their parent. */
  email?: string;
  githubRepo?: string;
  sentryProject?: string;
}

/** The one workspace a project reference points at, or null if none (or several) match. */
export function findWorkspace(query: WorkspaceQuery): Workspace | null {
  const rows = getDb().query("SELECT * FROM workspaces").all() as WorkspaceRow[];
  const all = rows.map(toWorkspace);
  let matches: Workspace[] = [];

  if (query.name) {
    const wanted = query.name.trim().toLowerCase();
    matches = all.filter((w) => w.name.toLowerCase() === wanted || w.aliases.includes(wanted));
  } else if (query.email) {
    const domain = query.email.trim().toLowerCase().split("@").pop() ?? "";
    matches = all.filter((w) =>
      w.emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`)),
    );
  } else if (query.githubRepo) {
    const wanted = query.githubRepo.trim().toLowerCase();
    matches = all.filter((w) => w.githubRepo?.toLowerCase() === wanted);
  } else if (query.sentryProject) {
    const wanted = query.sentryProject.trim().toLowerCase();
    matches = all.filter((w) => w.sentryProjects.includes(wanted));
  }
  return matches.length === 1 ? matches[0] : null;
}
