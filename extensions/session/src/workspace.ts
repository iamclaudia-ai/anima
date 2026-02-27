/**
 * Workspace CRUD
 *
 * Owns the workspace table in ~/.claudia/claudia.db.
 * Opens its own SQLite connection (WAL mode) for concurrent access
 * with the gateway process.
 *
 * Note: activeSessionId removed — sessions are read from filesystem.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { generateWorkspaceId, createLogger } from "@claudia/shared";

const log = createLogger("Workspace", join(homedir(), ".claudia", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

/** Raw row from SQLite (snake_case) */
interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  active_session_id: string | null; // Still in schema but we ignore it
  created_at: string;
  updated_at: string;
}

/** Convert DB row to API type */
function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Database ─────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  const claudiaDir = process.env.CLAUDIA_DATA_DIR || join(homedir(), ".claudia");
  if (!existsSync(claudiaDir)) {
    mkdirSync(claudiaDir, { recursive: true });
  }

  const dbPath = join(claudiaDir, "claudia.db");
  db = new Database(dbPath);

  // WAL mode for concurrent access with gateway
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Ensure workspaces table exists (gateway migrations create it,
  // but we need this for standalone extension testing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE,
      active_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
 * Resolve the Claude Code project directory for a given CWD.
 * Claude Code encodes paths by replacing / with - (dash).
 */
function resolveProjectDir(cwd: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  // Primary: Claude Code encodes cwd by replacing / with - (dash)
  const encodedCwd = cwd.replace(/\//g, "-");
  const primaryDir = join(projectsDir, encodedCwd);
  if (existsSync(primaryDir)) return primaryDir;

  // Fallback: scan for matching originalPath in sessions-index.json
  const dirs = readdirSync(projectsDir);
  for (const dir of dirs) {
    const indexPath = join(projectsDir, dir, "sessions-index.json");
    if (!existsSync(indexPath)) continue;
    try {
      const data = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (data.originalPath === cwd) return join(projectsDir, dir);
    } catch {
      // skip
    }
  }

  return null;
}

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
    const recentTimestamp = getMostRecentSessionTimestamp(workspace.cwd);
    // Use the most recent session timestamp if available, otherwise fall back to DB updated_at
    if (recentTimestamp) {
      workspace.updatedAt = recentTimestamp;
    }
    return workspace;
  });

  // Sort by updatedAt descending (most recent first)
  return workspaces.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

export function createWorkspace(params: { name: string; cwd: string }): Workspace {
  const id = generateWorkspaceId();
  getDb()
    .query("INSERT INTO workspaces (id, name, cwd) VALUES (?, ?, ?)")
    .run(id, params.name, params.cwd);

  return getWorkspace(id)!;
}

export function getOrCreateWorkspace(
  cwd: string,
  name?: string,
): { workspace: Workspace; created: boolean } {
  const existing = getWorkspaceByCwd(cwd);
  if (existing) {
    return { workspace: existing, created: false };
  }

  // Derive name from last path segment if not provided
  const derivedName = name || basename(cwd);
  const workspace = createWorkspace({ name: derivedName, cwd });
  return { workspace, created: true };
}

export function deleteWorkspace(cwd: string): boolean {
  const existing = getWorkspaceByCwd(cwd);
  if (!existing) return false;

  getDb().query("DELETE FROM workspaces WHERE cwd = ?").run(cwd);
  log.info("Deleted workspace", { cwd, id: existing.id });
  return true;
}
