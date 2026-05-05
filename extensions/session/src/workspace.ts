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
  createdAt: string;
  updatedAt: string;
}

/** Raw row from SQLite (snake_case) */
interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  general: number;
  pinned: number;
  active_session_id: string | null; // Still in schema but we ignore it
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

/** Convert DB row to API type */
function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd, // Keep full path for operations
    general: row.general === 1,
    pinned: row.pinned === 1,
    cwdDisplay: normalizePathForDisplay(row.cwd), // Normalized for display
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
