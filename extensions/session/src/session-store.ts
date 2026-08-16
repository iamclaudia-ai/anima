import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";

const log = createLogger("SessionStore", join(homedir(), ".anima", "logs", "session.log"));

/**
 * What the agent is doing right now — machine state, written by the lifecycle
 * path as events arrive from agent-host.
 *
 * `awaiting_input` and `awaiting_approval` are the states that used to be
 * invisible: a session blocked on a question, or on a permission prompt in its
 * tmux pane, was indistinguishable from an idle one.
 */
export type RuntimeStatus =
  | "idle"
  | "running"
  | "awaiting_input"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "stalled";

const RUNTIME_STATUSES: readonly RuntimeStatus[] = [
  "idle",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "completed",
  "failed",
  "interrupted",
  "stalled",
];

/** Runtime states that mean "this session is blocked on a human". */
export const AWAITING_STATUSES: readonly RuntimeStatus[] = ["awaiting_input", "awaiting_approval"];

/**
 * Where the work stands — human state, only ever written by a person.
 *
 * Deliberately not the same column as `status`. `status` records whether the
 * row still has a transcript on disk (the reconciler archives rows whose JSONL
 * Claude Code deleted); `disposition` records intent. Both can hide a row from
 * the default list, for entirely different reasons.
 */
export type SessionDisposition =
  | "open"
  | "needs_review"
  | "blocked"
  | "snoozed"
  | "resolved"
  | "archived";

const DISPOSITIONS: readonly SessionDisposition[] = [
  "open",
  "needs_review",
  "blocked",
  "snoozed",
  "resolved",
  "archived",
];

/**
 * Dispositions the workspace tree hides.
 *
 * Only `archived` — deliberately **not** `resolved`. The three dispositions
 * that matter form a progression, and each hides a session from one more
 * place than the last:
 *
 * - `open` — in the work queue. Shows in the ACTIVE pane *and* the tree.
 * - `resolved` — done. Drops out of the queue and back into its workspace
 *   folder, where it stays browsable. This is the common case, and hiding it
 *   from the tree as well would mean "mark done" quietly deleted your history.
 * - `archived` — gone from the sidebar entirely; findable only by search.
 *
 * That distinction is what makes it safe to resolve thousands of old sessions
 * to clear the queue: it declutters the thing that needs decluttering and
 * touches nothing else.
 */
export const HIDDEN_DISPOSITIONS: readonly SessionDisposition[] = ["archived"];

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return typeof value === "string" && (RUNTIME_STATUSES as readonly string[]).includes(value);
}

export function isSessionDisposition(value: unknown): value is SessionDisposition {
  return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

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
  disposition: string | null;
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
  disposition: SessionDisposition;
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
  /**
   * An explicit name the user gave this session.
   *
   * Separate from `firstPrompt` rather than replacing it: the derived title
   * stays available as the placeholder when renaming, and clearing a rename
   * falls straight back to it with nothing to recompute.
   */
  title?: string;
  firstPrompt?: string;
  gitBranch?: string;
  /** PR / ticket chips rendered under the title in the nav. */
  refs?: StoredSessionRef[];
  /** What the agent is doing — drives the live dot on the row. */
  runtimeStatus?: RuntimeStatus;
  /** Where the work stands — drives the chip and the default filter. */
  disposition?: SessionDisposition;
}

export interface StoredSessionRef {
  type: string;
  key: string;
  label: string;
  url?: string;
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
  const runtimeStatus: RuntimeStatus = isRuntimeStatus(row.runtime_status)
    ? row.runtime_status
    : "idle";
  const disposition: SessionDisposition = isSessionDisposition(row.disposition)
    ? row.disposition
    : "open";
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
    disposition,
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
      runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','awaiting_input','awaiting_approval','completed','failed','interrupted','stalled')),
      disposition         TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','needs_review','blocked','snoozed','resolved','archived')),
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
    "runtime_status TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','awaiting_input','awaiting_approval','completed','failed','interrupted','stalled'))",
  );
  addColumn(
    "disposition",
    "disposition TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','needs_review','blocked','snoozed','resolved','archived'))",
  );
  addColumn("metadata_json", "metadata_json TEXT");
  addColumn("updated_at", "updated_at TEXT NOT NULL DEFAULT (datetime('now'))");

  // A CHECK constraint can't be widened by ALTER TABLE, so a table left behind
  // by a pre-024 schema would reject `awaiting_input` at write time — deep
  // inside the lifecycle path, where the throw is far from the cause. Say so
  // here instead, once, at open.
  const tableSql = currentDb
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get() as { sql: string | null } | null;
  if (tableSql?.sql && !tableSql.sql.includes("awaiting_input")) {
    log.error(
      "sessions.runtime_status still carries the pre-024 CHECK constraint — " +
        "migration 024 has not run against this database, and awaiting_* writes will fail",
    );
  }

  currentDb.exec(
    "UPDATE sessions SET provider_session_id = COALESCE(provider_session_id, CAST(id AS TEXT))",
  );
  // Refs live in their own table rather than inside metadata_json: they're
  // multi-valued, they're a filter target for search, and the nav reads them
  // for every visible row — all of which want an index, not a JSON blob.
  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS session_refs (
      session_id  TEXT NOT NULL,
      ref_type    TEXT NOT NULL,
      ref_key     TEXT NOT NULL,
      ref_label   TEXT NOT NULL,
      ref_url     TEXT,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, ref_key)
    )
  `);
  currentDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_refs_key ON session_refs(ref_key);
    CREATE INDEX IF NOT EXISTS idx_session_refs_session ON session_refs(session_id);
  `);

  currentDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_provider_session ON sessions(provider_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_disposition ON sessions(workspace_id, disposition);
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

/**
 * The session extension's `anima.db` handle.
 *
 * Exposed so sibling modules (ref sync) can query alongside the session tables
 * in the same connection rather than opening a second one — two Bun SQLite
 * handles on a WAL database is a lock-contention source for no benefit.
 */
export function getSessionDb(): Database {
  return getDb();
}

export function closeSessionDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Insert or update a session row.
 *
 * `runtimeStatus` is preserved when omitted, the same protection `title` and
 * `disposition` have — and for the same reason. The reconciler upserts every
 * session it discovers on every pass with no opinion about runtime status, and
 * this used to reset the column to `idle` each time. That was invisible while
 * the only status that mattered was `running`, which a stream of events
 * re-writes several times a second. `awaiting_approval` is the first status
 * written once and then required to survive in silence — which is exactly what
 * a session blocked on a modal prompt does (#69), and it was being cleared
 * within seconds of every detection.
 */
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'idle'), ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        provider_session_id = excluded.provider_session_id,
        model = excluded.model,
        agent = excluded.agent,
        purpose = excluded.purpose,
        parent_session_id = excluded.parent_session_id,
        status = excluded.status,
        -- See the note above the function. Bound separately from the VALUES
        -- clause, which has already applied the default.
        runtime_status = COALESCE(?, sessions.runtime_status),
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
      params.runtimeStatus ?? null,
      params.title ?? null,
      params.summary ?? null,
      metadataJson,
      params.previousSessionId ?? null,
      params.lastActivity || now,
      now,
      now,
      // Second binding of the same value — the ON CONFLICT clause above.
      params.runtimeStatus ?? null,
    );
}

export function getStoredSession(id: string): StoredSession | null {
  const row = getDb()
    .query("SELECT * FROM sessions WHERE provider_session_id = ?")
    .get(id) as SessionRow | null;
  return row ? toStoredSession(row) : null;
}

/**
 * The runtime status a session currently has, without hydrating the whole row.
 *
 * Used on the hot lifecycle path, which runs per streamed event — a full
 * `getStoredSession()` there would parse metadata JSON thousands of times a
 * turn to answer a one-column question.
 */
export function getRuntimeStatus(id: string): RuntimeStatus | null {
  const row = getDb()
    .query("SELECT runtime_status FROM sessions WHERE provider_session_id = ?")
    .get(id) as { runtime_status: string | null } | null;
  if (!row) return null;
  return isRuntimeStatus(row.runtime_status) ? row.runtime_status : "idle";
}

/**
 * Bump `last_activity`, optionally moving the runtime status.
 *
 * Returns the transition when the status actually moved, and `null` when it
 * didn't. Callers use that to decide whether to emit `session.status_changed`:
 * this runs on every streamed event, so emitting unconditionally would put a
 * bus message behind every token.
 */
export function touchSession(
  id: string,
  runtimeStatus?: RuntimeStatus,
): { from: RuntimeStatus; to: RuntimeStatus } | null {
  const now = new Date().toISOString();
  if (!runtimeStatus) {
    getDb()
      .query("UPDATE sessions SET last_activity = ?, updated_at = ? WHERE provider_session_id = ?")
      .run(now, now, id);
    return null;
  }

  const previous = getRuntimeStatus(id);
  getDb()
    .query(
      "UPDATE sessions SET runtime_status = ?, last_activity = ?, updated_at = ? WHERE provider_session_id = ?",
    )
    .run(runtimeStatus, now, now, id);
  // A missing row means nothing was written, so there is no transition to
  // report — not a transition from "idle".
  if (previous === null || previous === runtimeStatus) return null;
  return { from: previous, to: runtimeStatus };
}

/**
 * Set (or clear) a session's disposition — the human axis.
 *
 * Deliberately not routed through `upsertSession`: the reconciler upserts every
 * session on every pass, and disposition is the one column it must never
 * touch. Keeping the write here means a sweep structurally cannot reset a
 * session someone marked `resolved`, the same way `set_title` is safe from it.
 *
 * Returns the transition, or `null` when the session doesn't exist or was
 * already in that disposition.
 */
export function setSessionDisposition(
  id: string,
  disposition: SessionDisposition,
): { from: SessionDisposition; to: SessionDisposition } | null {
  const row = getDb()
    .query("SELECT disposition FROM sessions WHERE provider_session_id = ?")
    .get(id) as { disposition: string | null } | null;
  if (!row) return null;
  const previous: SessionDisposition = isSessionDisposition(row.disposition)
    ? row.disposition
    : "open";
  if (previous === disposition) return null;

  getDb()
    .query("UPDATE sessions SET disposition = ?, updated_at = ? WHERE provider_session_id = ?")
    .run(disposition, new Date().toISOString(), id);
  return { from: previous, to: disposition };
}

/**
 * Write a runtime status alongside a metadata patch.
 *
 * Returns the transition when the status moved, `null` otherwise — same
 * contract as `touchSession`, so both status-writing paths can drive the same
 * event without the caller having to know which one it took.
 */
export function updateSessionRuntime(
  id: string,
  runtimeStatus: RuntimeStatus,
  metadataPatch?: Record<string, unknown>,
): { from: RuntimeStatus; to: RuntimeStatus } | null {
  const existing = getStoredSession(id);
  if (!existing) return null;
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
  return existing.runtimeStatus === runtimeStatus
    ? null
    : { from: existing.runtimeStatus, to: runtimeStatus };
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

/**
 * Set (or clear) a session's user-given name.
 *
 * `null` clears it, which is a real operation rather than an oversight: the
 * derived title is always recoverable from `metadata.firstPrompt`, so clearing
 * a rename should hand the row straight back to it rather than leaving an
 * empty string behind. The reconciler never touches this column — it writes
 * `metadata.firstPrompt` — so a rename survives every sweep.
 *
 * Returns false when no such session exists, so the method can 404 rather than
 * silently succeed.
 */
export function setSessionTitle(sessionId: string, title: string | null): boolean {
  const trimmed = title?.trim();
  const result = getDb()
    .query(
      `UPDATE sessions SET title = ?, updated_at = datetime('now')
       WHERE provider_session_id = ?`,
    )
    .run(trimmed ? trimmed : null, sessionId);
  return result.changes > 0;
}

/**
 * Replace a session's refs.
 *
 * Full replace rather than merge: refs are derived from the transcript, so a
 * re-extraction is authoritative and a ref that disappeared should not linger.
 */
export function setSessionRefs(sessionId: string, refs: StoredSessionRef[]): void {
  const dbConn = getDb();
  const write = dbConn.transaction((rows: StoredSessionRef[]) => {
    dbConn.query("DELETE FROM session_refs WHERE session_id = ?").run(sessionId);
    const insert = dbConn.query(
      `INSERT OR REPLACE INTO session_refs
         (session_id, ref_type, ref_key, ref_label, ref_url, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((ref, index) => {
      insert.run(sessionId, ref.type, ref.key, ref.label, ref.url ?? null, index);
    });
  });
  write(refs);
}

/**
 * Load refs for many sessions at once — the nav renders a whole page of rows,
 * so this must not become a query per row.
 */
export function getRefsForSessions(sessionIds: string[]): Map<string, StoredSessionRef[]> {
  const bySession = new Map<string, StoredSessionRef[]>();
  if (sessionIds.length === 0) return bySession;

  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = getDb()
    .query(
      `SELECT session_id, ref_type, ref_key, ref_label, ref_url
       FROM session_refs
       WHERE session_id IN (${placeholders})
       ORDER BY session_id, position`,
    )
    .all(...sessionIds) as Array<{
    session_id: string;
    ref_type: string;
    ref_key: string;
    ref_label: string;
    ref_url: string | null;
  }>;

  for (const row of rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push({
      type: row.ref_type,
      key: row.ref_key,
      label: row.ref_label,
      url: row.ref_url ?? undefined,
    });
    bySession.set(row.session_id, list);
  }
  return bySession;
}

export interface SessionForRefSync {
  sessionId: string;
  cwd: string;
  /** Derived first prompt, falling back to a stored title. */
  titleText?: string;
  refs: StoredSessionRef[];
}

/**
 * Sessions with conversation activity since `sinceIso`, with everything ref
 * extraction needs.
 *
 * Recency comes from the transcript corpus, not `last_activity`. That column
 * is unreliable for this: the first reconcile stamped it with "now" on all
 * 5,103 rows it archived, so a 30-day cut on it sweeps in sessions from
 * March. The timestamp on a message is what actually says when a conversation
 * happened. Sessions with no ingested messages fall back to `created_at`, so
 * one created moments ago still gets its opening prompt read.
 *
 * Archived rows are included on purpose: their transcripts are gone from disk
 * but the corpus still has the prose, and their refs are exactly what makes
 * them findable again.
 */
export function listSessionsForRefSync(
  sinceIso: string,
  options: { corpusAvailable: boolean },
): SessionForRefSync[] {
  // Without memory's table the EXISTS clause can't be planned at all, so fall
  // back to creation date — title-only extraction, which is where refs started.
  const recencyClause = options.corpusAvailable
    ? `(s.created_at >= ?1
        OR EXISTS (SELECT 1 FROM memory_transcript_entries e
                    WHERE e.session_id = s.provider_session_id AND e.timestamp >= ?1))`
    : `s.created_at >= ?1`;

  const rows = getDb()
    .query(
      `SELECT s.provider_session_id AS session_id, s.title AS title,
              s.metadata_json AS metadata_json, w.cwd AS cwd
         FROM sessions s
         JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.purpose = 'chat' AND ${recencyClause}
        ORDER BY s.last_activity DESC`,
    )
    .all(sinceIso) as Array<{
    session_id: string;
    title: string | null;
    metadata_json: string | null;
    cwd: string;
  }>;

  const refsBySession = getRefsForSessions(rows.map((row) => row.session_id));

  return rows.map((row) => {
    const metadata = parseMetadata(row.metadata_json);
    const firstPrompt =
      typeof metadata?.firstPrompt === "string" ? metadata.firstPrompt : undefined;
    return {
      sessionId: row.session_id,
      cwd: row.cwd,
      // Derived prompt first: it's the session's actual opening text, so it
      // carries refs. A user rename is a label and usually doesn't.
      titleText: firstPrompt ?? row.title ?? undefined,
      refs: refsBySession.get(row.session_id) ?? [],
    };
  });
}

export interface SessionSearchRow {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  title?: string;
  firstPrompt?: string;
  modified: string;
  /** Archived rows have no transcript on disk — the UI opens them read-only. */
  archived: boolean;
  /** Where the work stands, so search can filter on it the way the nav does. */
  disposition: SessionDisposition;
  refs: StoredSessionRef[];
}

/**
 * Hydrate search hits into rows the nav can render.
 *
 * Search matches the transcript corpus, which reaches further back than the
 * session table's live rows — memory holds 2,411 sessions where only ~360
 * transcripts still exist on disk. A hit with no session row here is one whose
 * workspace was never registered; the caller drops it rather than rendering a
 * link that goes nowhere. Archived rows *are* returned, flagged, because their
 * prose is the whole reason they're findable.
 */
export function getSessionsForSearch(sessionIds: readonly string[]): Map<string, SessionSearchRow> {
  const found = new Map<string, SessionSearchRow>();
  if (sessionIds.length === 0) return found;

  const db = getDb();
  const refsBySession = getRefsForSessions([...sessionIds]);

  for (let i = 0; i < sessionIds.length; i += 400) {
    const ids = sessionIds.slice(i, i + 400);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT s.provider_session_id AS session_id, s.title, s.metadata_json,
                s.status, s.disposition, s.last_activity,
                w.id AS workspace_id, w.name AS workspace_name,
                w.cwd AS cwd
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
          WHERE s.provider_session_id IN (${placeholders})`,
      )
      .all(...ids) as Array<{
      session_id: string;
      title: string | null;
      metadata_json: string | null;
      status: "active" | "archived";
      disposition: string | null;
      last_activity: string;
      workspace_id: string;
      workspace_name: string;
      cwd: string;
    }>;

    for (const row of rows) {
      const metadata = parseMetadata(row.metadata_json);
      found.set(row.session_id, {
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        cwd: row.cwd,
        title: row.title ?? undefined,
        firstPrompt: typeof metadata?.firstPrompt === "string" ? metadata.firstPrompt : undefined,
        modified: row.last_activity,
        archived: row.status === "archived",
        disposition: isSessionDisposition(row.disposition) ? row.disposition : "open",
        refs: refsBySession.get(row.session_id) ?? [],
      });
    }
  }

  return found;
}

/** Sessions referencing a given PR/ticket key, most recently active first. */
export function findSessionsByRef(refKey: string): string[] {
  const rows = getDb()
    .query(
      `SELECT r.session_id FROM session_refs r
       JOIN sessions s ON s.provider_session_id = r.session_id
       WHERE r.ref_key = ?
       ORDER BY s.last_activity DESC`,
    )
    .all(refKey) as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

/**
 * Sessions for one workspace's nav section.
 *
 * `resolved` and `archived` are hidden by default — that's the payoff of
 * splitting the axes, and the reason a list stops growing without bound. They
 * are still one `includeDispositions` away, because a filter you can't undo is
 * a data-loss bug wearing a UI costume.
 */
export function listWorkspaceSessions(
  workspaceId: string,
  options?: { includeDispositions?: readonly SessionDisposition[] },
): SessionListInfo[] {
  // An empty allow-list means "no filter given", not "match nothing" — the
  // latter would compile to `IN ()`, which SQLite rejects outright.
  const shown = options?.includeDispositions?.length ? options.includeDispositions : undefined;
  const dispositionClause = shown
    ? `AND disposition IN (${shown.map(() => "?").join(",")})`
    : `AND disposition NOT IN (${HIDDEN_DISPOSITIONS.map(() => "?").join(",")})`;
  const dispositionValues = shown ? [...shown] : [...HIDDEN_DISPOSITIONS];

  const rows = getDb()
    .query(
      `SELECT * FROM sessions
       WHERE workspace_id = ? AND purpose = 'chat' AND status = 'active' ${dispositionClause}
       ORDER BY last_activity DESC`,
    )
    .all(workspaceId, ...dispositionValues) as SessionRow[];

  // One batched lookup for the whole page rather than a query per row.
  const refsBySession = getRefsForSessions(rows.map((row) => row.provider_session_id));

  return rows.map((row) => {
    const stored = toStoredSession(row);
    const metadata = stored.metadata || {};
    return {
      refs: refsBySession.get(stored.id),
      runtimeStatus: stored.runtimeStatus,
      disposition: stored.disposition,
      sessionId: stored.id,
      created: stored.createdAt,
      modified: stored.lastActivity,
      messageCount:
        typeof metadata.messageCount === "number" ? (metadata.messageCount as number) : undefined,
      title: stored.title || undefined,
      firstPrompt:
        typeof metadata.firstPrompt === "string" ? (metadata.firstPrompt as string) : undefined,
      gitBranch:
        typeof metadata.gitBranch === "string" ? (metadata.gitBranch as string) : undefined,
    };
  });
}

/** Runtime states that mean the agent is mid-something. */
const IN_FLIGHT_STATUSES: readonly RuntimeStatus[] = [
  "running",
  "awaiting_input",
  "awaiting_approval",
  "failed",
  "stalled",
];

export interface AttentionSession {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  title: string | null;
  firstPrompt: string | null;
  runtimeStatus: RuntimeStatus;
  disposition: SessionDisposition;
  lastActivity: string;
  /**
   * What "waiting 20 minutes" counts from.
   *
   * Not `last_activity`, which is restamped whenever agent-host readopts a
   * live CLI pane — so a gateway restart would silently reset every waiting
   * clock, and the escalation would never fire for anyone who reloads.
   * `metadata.lastAssistantMessageAt` is written once, by `turn_stop`, and
   * means exactly "when the turn ended".
   */
  waitingSince: string;
  /** Set while snoozed; the session reappears once this passes. */
  snoozedUntil: string | null;
  /** PR / ticket chips — the queue row should read like the tree row. */
  refs: StoredSessionRef[];
}

/**
 * Everything currently wanting Michael's attention, across every workspace.
 *
 * One predicate, two consumers. The banner asks "should I interrupt?" and the
 * active pane asks "what's happening right now" — they're the same set, so it
 * lives in one place rather than drifting into two definitions of "active".
 *
 * Two halves:
 *
 * - **In flight** — `running` and friends. The agent is mid-something.
 * - **Done and unacknowledged** — `completed` with `disposition = open`. This
 *   is the half the original plan missed. Asking for a PR review and then
 *   forgetting to come back is the case that actually costs time, and nothing
 *   in the system represented it: the session was finished, unremarkable, and
 *   indistinguishable from work that had been dealt with.
 *
 * Deliberately **not** paginated per workspace. The nav's per-workspace pages
 * are what lose a workspace's 7th-most-recent session, and a set defined by
 * status can't have that problem — membership is the status itself. The set is
 * naturally small, because it's a description of right now.
 *
 * Snoozed sessions drop out until their timer passes, which is what makes
 * snooze mean "remind me later" rather than "never mind". Note that `snoozed`
 * is admitted by the predicate and excluded by the *timestamp* — the first
 * version filtered on disposition alone, which meant a snoozed session failed
 * the `completed + open` branch permanently and never came back. Snooze was
 * dismissal wearing a friendlier label; the timestamp is the source of truth
 * for whether it's quiet right now, and the disposition only records that a
 * snooze was set.
 */
export function listAttentionSessions(options?: {
  now?: string;
  /**
   * Always include this session, whatever its disposition.
   *
   * The session a tab has open belongs in the queue even when it's resolved:
   * reopening old work from search is a normal way to start, and the pane is
   * where its status can be changed back. A row you're actively looking at
   * that offers no way to act on itself is just a gap.
   */
  includeSessionId?: string;
  /**
   * Ceiling on rows, newest first.
   *
   * The queue is "everything still open", which is unbounded by construction
   * and is only small because resolving keeps it small. This is the guard for
   * a database that hasn't been tidied yet — better a capped list than five
   * thousand rows over the wire.
   */
  limit?: number;
  /**
   * Workspaces whose sessions never enter the queue, by name or by cwd.
   *
   * Some workspaces are machinery rather than work. Libby's summarization runs
   * produce a session per conversation and nobody ever acts on one, so they'd
   * dominate a list meant to answer "what am I in the middle of". Excluding
   * them here rather than resolving them keeps the distinction honest: they
   * aren't finished work, they're work that was never yours.
   *
   * The queue only — those sessions stay in their workspace folder and in
   * search, and the tab's own session is still force-included, so opening one
   * deliberately still gives you a row to act on.
   */
  excludeWorkspaces?: readonly string[];
}): AttentionSession[] {
  const nowIso = options?.now ?? new Date().toISOString();
  const limit = options?.limit ?? 200;
  const excluded = (options?.excludeWorkspaces ?? []).map((name) => name.toLowerCase());
  const excludeClause = excluded.length
    ? `AND (LOWER(w.name) NOT IN (${excluded.map(() => "?").join(",")})
           AND LOWER(w.cwd) NOT IN (${excluded.map(() => "?").join(",")}))`
    : "";

  const rows = getDb()
    .query(
      `SELECT s.provider_session_id AS session_id, s.title, s.metadata_json,
              s.runtime_status, s.disposition, s.last_activity,
              w.id AS workspace_id, w.name AS workspace_name, w.cwd AS cwd
         FROM sessions s
         JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.purpose = 'chat'
          AND s.status = 'active'
          AND (
            (s.disposition IN ('open','needs_review','blocked','snoozed') ${excludeClause})
            OR s.provider_session_id = ?
          )
        ORDER BY s.last_activity DESC
        LIMIT ?`,
    )
    .all(...excluded, ...excluded, options?.includeSessionId ?? "", limit) as Array<{
    session_id: string;
    title: string | null;
    metadata_json: string | null;
    runtime_status: string | null;
    disposition: string | null;
    last_activity: string;
    workspace_id: string;
    workspace_name: string;
    cwd: string;
  }>;

  const refsBySession = getRefsForSessions(rows.map((row) => row.session_id));
  const result: AttentionSession[] = [];
  for (const row of rows) {
    const metadata = parseMetadata(row.metadata_json);
    const snoozedUntil = typeof metadata?.snoozedUntil === "string" ? metadata.snoozedUntil : null;
    const isCurrent = row.session_id === options?.includeSessionId;
    // A live snooze hides the row entirely rather than flagging it — a muted
    // item still in the list is just a quieter version of the nagging. The
    // session you're looking at is exempt: hiding the row for the thing on
    // screen would leave no way to change its status.
    if (!isCurrent && snoozedUntil && snoozedUntil > nowIso) continue;

    const runtimeStatus: RuntimeStatus = isRuntimeStatus(row.runtime_status)
      ? row.runtime_status
      : "idle";
    // A session blocked on a modal prompt has been waiting since the prompt
    // appeared, which is not when its last turn ended — that turn hasn't ended.
    // Without this, a session blocked mid-turn reports the *previous* turn's
    // age and can arrive already overdue.
    const blockedSince =
      AWAITING_STATUSES.includes(runtimeStatus) && typeof metadata?.blockedSince === "string"
        ? metadata.blockedSince
        : null;
    const waitingSince =
      blockedSince ??
      (typeof metadata?.lastAssistantMessageAt === "string"
        ? metadata.lastAssistantMessageAt
        : row.last_activity);
    // No age cutoff. An earlier version aged rows out after a day, which was
    // right for a banner and wrong for a queue: a queue that quietly forgets
    // items is worse than one that's long, and resolving is the intended way
    // to shorten it. The banner applies its own window on top of this.

    result.push({
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      cwd: row.cwd,
      title: row.title,
      firstPrompt: typeof metadata?.firstPrompt === "string" ? metadata.firstPrompt : null,
      runtimeStatus,
      disposition: isSessionDisposition(row.disposition) ? row.disposition : "open",
      lastActivity: row.last_activity,
      waitingSince,
      snoozedUntil,
      refs: refsBySession.get(row.session_id) ?? [],
    });
  }
  return result;
}

/**
 * Snooze a session until `untilIso`, or clear the snooze with `null`.
 *
 * The timestamp lives in `metadata_json` rather than a column: `disposition`
 * already says *what* the state is, and this is only the *when*. Adding a
 * column for it would mean another table rebuild for a field nothing filters
 * or joins on.
 */
/**
 * Bulk-resolve the backlog — the queue's bootstrap.
 *
 * The ACTIVE pane holds every unresolved session, which on a database that has
 * never been tidied means thousands of rows going back months. Resolving them
 * is the intended way to shorten that list, and it is safe precisely because
 * `resolved` no longer hides a session from the workspace tree: the row leaves
 * the queue and stays exactly where it was for browsing.
 *
 * An earlier version restricted this to `completed` rows, back when resolving
 * *did* hide a session — a sweep would have emptied every folder. That
 * constraint is gone with the tree/queue split, so this now covers any
 * unresolved session with no activity in the window.
 *
 * Reversible: `session.set_status` puts any of them back to `open`.
 */
export function resolveStaleCompleted(options: {
  olderThanDays: number;
  dryRun?: boolean;
  now?: string;
}): {
  matched: number;
  resolved: number;
  sessions: Array<{ sessionId: string; lastActivity: string }>;
} {
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const cutoff = new Date(nowMs - options.olderThanDays * 86_400_000).toISOString();

  const rows = getDb()
    .query(
      `SELECT provider_session_id AS session_id, last_activity
         FROM sessions
        WHERE purpose = 'chat'
          AND status = 'active'
          AND disposition IN ('open','needs_review','blocked','snoozed')
          AND last_activity < ?
        ORDER BY last_activity DESC`,
    )
    .all(cutoff) as Array<{ session_id: string; last_activity: string }>;

  const sessions = rows.map((row) => ({
    sessionId: row.session_id,
    lastActivity: row.last_activity,
  }));
  if (options.dryRun) return { matched: rows.length, resolved: 0, sessions };

  const dbConn = getDb();
  const write = dbConn.transaction((ids: string[]) => {
    const update = dbConn.query(
      `UPDATE sessions SET disposition = 'resolved', updated_at = datetime('now')
        WHERE provider_session_id = ?`,
    );
    for (const id of ids) update.run(id);
  });
  write(sessions.map((s) => s.sessionId));

  return { matched: rows.length, resolved: sessions.length, sessions };
}

export function setSessionSnooze(sessionId: string, untilIso: string | null): boolean {
  const existing = getStoredSession(sessionId);
  if (!existing) return false;
  const metadata = { ...(existing.metadata || {}) };
  if (untilIso) metadata.snoozedUntil = untilIso;
  else delete metadata.snoozedUntil;

  getDb()
    .query("UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE provider_session_id = ?")
    .run(JSON.stringify(metadata), new Date().toISOString(), sessionId);
  return true;
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
