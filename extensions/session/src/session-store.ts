import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";

const log = createLogger("SessionStore", join(homedir(), ".anima", "logs", "session.log"));

export type RuntimeStatus = "idle" | "running" | "completed" | "failed" | "interrupted" | "stalled";
export type SessionPurpose = "chat" | "subagent" | "review" | "test";

interface SessionRow {
  id: number;
  workspace_id: string;
  provider_session_id: string;
  model: string;
  agent: string | null;
  purpose: string | null;
  parent_session_id: string | null;
  status: "active" | "archived";
  runtime_status: string | null;
  title: string | null;
  summary: string | null;
  metadata_json: string | null;
  previous_session_id: string | null;
  last_activity: string;
  created_at: string;
  updated_at: string | null;
}

export interface StoredSession {
  id: string;
  workspaceId: string;
  providerSessionId: string;
  model: string;
  agent: string;
  purpose: SessionPurpose;
  parentSessionId: string | null;
  status: "active" | "archived";
  runtimeStatus: RuntimeStatus;
  title: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  previousSessionId: string | null;
  lastActivity: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListInfo {
  sessionId: string;
  created: string;
  modified: string;
  messageCount?: number;
  firstPrompt?: string;
  gitBranch?: string;
}

let db: Database | null = null;

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toStoredSession(row: SessionRow): StoredSession {
  if (!row.model || !row.model.trim()) {
    throw new Error(`Session ${row.provider_session_id} is missing model`);
  }
  const runtimeRaw = row.runtime_status || "idle";
  const runtimeStatus: RuntimeStatus =
    runtimeRaw === "running" ||
    runtimeRaw === "completed" ||
    runtimeRaw === "failed" ||
    runtimeRaw === "interrupted" ||
    runtimeRaw === "stalled"
      ? runtimeRaw
      : "idle";
  const purposeRaw = row.purpose || "chat";
  const purpose: SessionPurpose =
    purposeRaw === "subagent" || purposeRaw === "review" || purposeRaw === "test"
      ? purposeRaw
      : "chat";
  return {
    id: row.provider_session_id,
    workspaceId: row.workspace_id,
    providerSessionId: row.provider_session_id,
    model: row.model,
    agent: row.agent || "claude",
    purpose,
    parentSessionId: row.parent_session_id,
    status: row.status,
    runtimeStatus,
    title: row.title,
    summary: row.summary,
    metadata: parseMetadata(row.metadata_json),
    previousSessionId: row.previous_session_id,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.last_activity,
  };
}

function ensureSessionTable(currentDb: Database): void {
  currentDb.exec(`
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

  const workspaceColumns = currentDb.query("PRAGMA table_info(workspaces)").all() as Array<{
    name: string;
  }>;
  if (!workspaceColumns.some((column) => column.name === "general")) {
    currentDb.exec("ALTER TABLE workspaces ADD COLUMN general INTEGER NOT NULL DEFAULT 0");
  }
  if (!workspaceColumns.some((column) => column.name === "pinned")) {
    currentDb.exec("ALTER TABLE workspaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }

  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
      provider_session_id TEXT NOT NULL UNIQUE,
      model               TEXT NOT NULL,
      agent               TEXT NOT NULL DEFAULT 'claude',
      purpose             TEXT NOT NULL DEFAULT 'chat',
      parent_session_id   TEXT,
      status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','completed','failed','interrupted','stalled')),
      title               TEXT,
      summary             TEXT,
      metadata_json       TEXT,
      previous_session_id TEXT,
      last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const columns = currentDb.query("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
    type: string;
  }>;
  const byName = new Set(columns.map((c) => c.name));

  const addColumn = (name: string, sql: string): void => {
    if (byName.has(name)) return;
    currentDb.exec(`ALTER TABLE sessions ADD COLUMN ${sql}`);
  };

  // Backfill for legacy schemas from early migrations.
  addColumn("provider_session_id", "provider_session_id TEXT");
  addColumn("model", "model TEXT");
  addColumn("agent", "agent TEXT NOT NULL DEFAULT 'claude'");
  addColumn("purpose", "purpose TEXT NOT NULL DEFAULT 'chat'");
  addColumn("parent_session_id", "parent_session_id TEXT");
  addColumn(
    "runtime_status",
    "runtime_status TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','completed','failed','interrupted','stalled'))",
  );
  addColumn("metadata_json", "metadata_json TEXT");
  addColumn("updated_at", "updated_at TEXT NOT NULL DEFAULT (datetime('now'))");

  currentDb.exec(
    "UPDATE sessions SET provider_session_id = COALESCE(provider_session_id, CAST(id AS TEXT))",
  );
  currentDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_provider_session ON sessions(provider_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
  `);
}

function getDb(): Database {
  if (db) return db;

  const claudiaDir = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
  if (!existsSync(claudiaDir)) {
    mkdirSync(claudiaDir, { recursive: true });
  }
  const dbPath = join(claudiaDir, "anima.db");
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSessionTable(db);
  log.info("Opened session database", { path: dbPath });
  return db;
}

export function closeSessionDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function upsertSession(params: {
  id: string;
  workspaceId: string;
  providerSessionId?: string;
  model?: string;
  agent?: string;
  purpose?: SessionPurpose;
  parentSessionId?: string | null;
  status?: "active" | "archived";
  runtimeStatus?: RuntimeStatus;
  title?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  previousSessionId?: string | null;
  lastActivity?: string;
}): void {
  const now = new Date().toISOString();
  const providerSessionId = params.providerSessionId || params.id;
  const agent = params.agent || "claude";
  const model = params.model?.trim();
  if (!model) {
    throw new Error("Session model is required for upsertSession");
  }
  const metadataJson =
    params.metadata === undefined ? null : params.metadata ? JSON.stringify(params.metadata) : null;
  const dbConn = getDb();

  const workspaceExists = dbConn
    .query("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1")
    .get(params.workspaceId) as { 1: number } | null;
  if (!workspaceExists) {
    dbConn
      .query("INSERT OR IGNORE INTO workspaces (id, name, cwd) VALUES (?, ?, ?)")
      .run(
        params.workspaceId,
        `workspace-${params.workspaceId.slice(0, 8)}`,
        `/virtual/${params.workspaceId}`,
      );
  }

  dbConn
    .query(
      `INSERT INTO sessions (
        workspace_id, provider_session_id, model, agent, purpose, parent_session_id,
        status, runtime_status, title, summary, metadata_json, previous_session_id,
        last_activity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        provider_session_id = excluded.provider_session_id,
        model = excluded.model,
        agent = excluded.agent,
        purpose = excluded.purpose,
        parent_session_id = excluded.parent_session_id,
        status = excluded.status,
        runtime_status = excluded.runtime_status,
        title = COALESCE(excluded.title, sessions.title),
        summary = COALESCE(excluded.summary, sessions.summary),
        metadata_json = COALESCE(excluded.metadata_json, sessions.metadata_json),
        previous_session_id = COALESCE(excluded.previous_session_id, sessions.previous_session_id),
        last_activity = excluded.last_activity,
        updated_at = excluded.updated_at`,
    )
    .run(
      params.workspaceId,
      providerSessionId,
      model,
      agent,
      params.purpose || "chat",
      params.parentSessionId ?? null,
      params.status || "active",
      params.runtimeStatus || "idle",
      params.title ?? null,
      params.summary ?? null,
      metadataJson,
      params.previousSessionId ?? null,
      params.lastActivity || now,
      now,
      now,
    );
}

export function getStoredSession(id: string): StoredSession | null {
  const row = getDb()
    .query("SELECT * FROM sessions WHERE provider_session_id = ?")
    .get(id) as SessionRow | null;
  return row ? toStoredSession(row) : null;
}

export function touchSession(id: string, runtimeStatus?: RuntimeStatus): void {
  const now = new Date().toISOString();
  if (runtimeStatus) {
    getDb()
      .query(
        "UPDATE sessions SET runtime_status = ?, last_activity = ?, updated_at = ? WHERE provider_session_id = ?",
      )
      .run(runtimeStatus, now, now, id);
    return;
  }
  getDb()
    .query("UPDATE sessions SET last_activity = ?, updated_at = ? WHERE provider_session_id = ?")
    .run(now, now, id);
}

export function updateSessionRuntime(
  id: string,
  runtimeStatus: RuntimeStatus,
  metadataPatch?: Record<string, unknown>,
): void {
  const existing = getStoredSession(id);
  if (!existing) return;
  const mergedMetadata =
    metadataPatch === undefined
      ? existing?.metadata || null
      : { ...(existing?.metadata || {}), ...metadataPatch };
  upsertSession({
    id,
    workspaceId: existing.workspaceId,
    providerSessionId: existing.providerSessionId,
    model: existing.model,
    agent: existing.agent,
    purpose: existing.purpose,
    parentSessionId: existing.parentSessionId ?? null,
    status: existing.status,
    runtimeStatus,
    title: existing.title ?? null,
    summary: existing.summary ?? null,
    metadata: mergedMetadata,
    previousSessionId: existing.previousSessionId ?? null,
  });
}

export function setWorkspaceActiveSession(workspaceId: string, sessionId: string): void {
  getDb()
    .query("UPDATE workspaces SET active_session_id = ?, updated_at = ? WHERE id = ?")
    .run(sessionId, new Date().toISOString(), workspaceId);
}

export function getWorkspaceActiveSession(workspaceId: string): string | null {
  const row = getDb()
    .query("SELECT active_session_id FROM workspaces WHERE id = ?")
    .get(workspaceId) as { active_session_id: string | null } | null;
  return row?.active_session_id || null;
}

export function listWorkspaceSessions(workspaceId: string): SessionListInfo[] {
  const rows = getDb()
    .query(
      `SELECT * FROM sessions
       WHERE workspace_id = ? AND purpose = 'chat' AND status = 'active'
       ORDER BY last_activity DESC`,
    )
    .all(workspaceId) as SessionRow[];

  return rows.map((row) => {
    const stored = toStoredSession(row);
    const metadata = stored.metadata || {};
    return {
      sessionId: stored.id,
      created: stored.createdAt,
      modified: stored.lastActivity,
      messageCount:
        typeof metadata.messageCount === "number" ? (metadata.messageCount as number) : undefined,
      firstPrompt:
        typeof metadata.firstPrompt === "string"
          ? (metadata.firstPrompt as string)
          : stored.title || undefined,
      gitBranch:
        typeof metadata.gitBranch === "string" ? (metadata.gitBranch as string) : undefined,
    };
  });
}

export function listSubagentSessions(filters?: {
  parentSessionId?: string;
  status?: "running" | "completed" | "failed" | "interrupted";
  agent?: string;
}): StoredSession[] {
  const clauses = ["parent_session_id IS NOT NULL", "status = 'active'"];
  const values: string[] = [];

  if (filters?.parentSessionId) {
    clauses.push("parent_session_id = ?");
    values.push(filters.parentSessionId);
  }
  if (filters?.status) {
    clauses.push("runtime_status = ?");
    values.push(filters.status);
  }
  if (filters?.agent) {
    clauses.push("agent = ?");
    values.push(filters.agent);
  }

  const sql = `SELECT * FROM sessions WHERE ${clauses.join(" AND ")} ORDER BY last_activity DESC`;
  const rows = getDb()
    .query(sql)
    .all(...values) as SessionRow[];
  return rows.map(toStoredSession);
}
