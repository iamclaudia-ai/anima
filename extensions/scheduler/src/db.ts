/**
 * Scheduler Extension — Database Access Layer
 *
 * SQLite storage for scheduled tasks and execution history.
 * Opens its own bun:sqlite connection to ~/.anima/anima.db.
 * WAL mode + busy_timeout for safe concurrent access.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = join(homedir(), ".anima", "anima.db");
let dbPath = DEFAULT_DB_PATH;

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Test helper to redirect the SQLite file path.
 * Resets the active connection when changed.
 */
export function setDbPathForTests(path: string | null): void {
  closeDb();
  dbPath = path ?? DEFAULT_DB_PATH;
}

/**
 * Test helper — creates scheduler tables in the test DB.
 * In production, the gateway migration system (018-scheduler-tables.sql) handles this.
 */
export function setupSchemaForTests(): void {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_tasks (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      description            TEXT,
      type                   TEXT NOT NULL CHECK(type IN ('once', 'interval', 'cron')),
      fire_at                TEXT NOT NULL,
      interval_seconds       INTEGER,
      cron_expr              TEXT,
      action_type            TEXT NOT NULL CHECK(action_type IN ('emit', 'extension_call', 'notification', 'exec')),
      action_target          TEXT NOT NULL,
      action_payload         TEXT,
      missed_policy          TEXT NOT NULL DEFAULT 'fire_once' CHECK(missed_policy IN ('fire_once', 'skip', 'fire_all')),
      concurrency            TEXT NOT NULL DEFAULT 'skip_if_running' CHECK(concurrency IN ('allow', 'skip_if_running', 'cancel_previous')),
      start_deadline_seconds INTEGER,
      enabled                INTEGER NOT NULL DEFAULT 1,
      tags                   TEXT,
      created_at             TEXT NOT NULL,
      fired_count            INTEGER NOT NULL DEFAULT 0,
      last_fired_at          TEXT,
      keep_history           INTEGER NOT NULL DEFAULT 50,
      output_dir             TEXT
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_task_executions (
      id               TEXT PRIMARY KEY,
      task_id          TEXT NOT NULL REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
      fired_at         TEXT NOT NULL,
      completed_at     TEXT,
      status           TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped', 'cancelled')),
      duration_ms      INTEGER,
      error            TEXT,
      output           TEXT,
      progress_message TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_sched_exec_task ON scheduler_task_executions(task_id, fired_at DESC)`,
  );
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_sched_tasks_fire ON scheduler_tasks(fire_at) WHERE enabled = 1`,
  );
}

// ── Types ───────────────────────────────────────────────────

export interface TaskRow {
  id: string;
  name: string;
  description: string | null;
  type: "once" | "interval" | "cron";
  fire_at: string;
  interval_seconds: number | null;
  cron_expr: string | null;
  action_type: "emit" | "extension_call" | "notification" | "exec";
  action_target: string;
  action_payload: string | null;
  missed_policy: "fire_once" | "skip" | "fire_all";
  concurrency: "allow" | "skip_if_running" | "cancel_previous";
  start_deadline_seconds: number | null;
  enabled: number;
  tags: string | null;
  created_at: string;
  fired_count: number;
  last_fired_at: string | null;
  keep_history: number;
  output_dir: string | null;
}

export interface ExecutionRow {
  id: string;
  task_id: string;
  fired_at: string;
  completed_at: string | null;
  status: "running" | "success" | "error" | "skipped" | "cancelled";
  duration_ms: number | null;
  error: string | null;
  output: string | null;
  progress_message: string | null;
  created_at: string;
}

/** The shape used by the rest of the extension (not raw SQL rows). */
export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  type: "once" | "interval" | "cron";
  fireAt: string;
  intervalSeconds?: number;
  cronExpr?: string;
  action: {
    type: "emit" | "extension_call" | "notification" | "exec";
    target: string;
    payload?: Record<string, unknown>;
  };
  missedPolicy: "fire_once" | "skip" | "fire_all";
  concurrency: "allow" | "skip_if_running" | "cancel_previous";
  startDeadlineSeconds?: number;
  enabled: boolean;
  tags?: string[];
  createdAt: string;
  firedCount: number;
  lastFiredAt?: string;
  keepHistory: number;
  /** Output directory pattern with template variables. Resolved and auto-created via {{task.output_dir}}. */
  outputDir?: string;
}

// ── Row ↔ Task conversion ───────────────────────────────────

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type,
    fireAt: row.fire_at,
    intervalSeconds: row.interval_seconds ?? undefined,
    cronExpr: row.cron_expr ?? undefined,
    action: {
      type: row.action_type,
      target: row.action_target,
      payload: row.action_payload ? JSON.parse(row.action_payload) : undefined,
    },
    missedPolicy: row.missed_policy,
    concurrency: row.concurrency,
    startDeadlineSeconds: row.start_deadline_seconds ?? undefined,
    enabled: row.enabled === 1,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    createdAt: row.created_at,
    firedCount: row.fired_count,
    lastFiredAt: row.last_fired_at ?? undefined,
    keepHistory: row.keep_history,
    outputDir: row.output_dir ?? undefined,
  };
}

// ── CRUD ────────────────────────────────────────────────────

export function insertTask(task: ScheduledTask): void {
  getDb()
    .query(
      `INSERT INTO scheduler_tasks
       (id, name, description, type, fire_at, interval_seconds, cron_expr,
        action_type, action_target, action_payload,
        missed_policy, concurrency, start_deadline_seconds,
        enabled, tags, created_at, fired_count, last_fired_at, keep_history, output_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.name,
      task.description ?? null,
      task.type,
      task.fireAt,
      task.intervalSeconds ?? null,
      task.cronExpr ?? null,
      task.action.type,
      task.action.target,
      task.action.payload ? JSON.stringify(task.action.payload) : null,
      task.missedPolicy,
      task.concurrency,
      task.startDeadlineSeconds ?? null,
      task.enabled ? 1 : 0,
      task.tags ? JSON.stringify(task.tags) : null,
      task.createdAt,
      task.firedCount,
      task.lastFiredAt ?? null,
      task.keepHistory,
      task.outputDir ?? null,
    );
}

export function getAllTasks(): ScheduledTask[] {
  const rows = getDb().query(`SELECT * FROM scheduler_tasks`).all() as TaskRow[];
  return rows.map(rowToTask);
}

export function getEnabledDueTasks(nowIso: string): ScheduledTask[] {
  const rows = getDb()
    .query(`SELECT * FROM scheduler_tasks WHERE enabled = 1 AND fire_at <= ?`)
    .all(nowIso) as TaskRow[];
  return rows.map(rowToTask);
}

export function getTaskById(id: string): ScheduledTask | null {
  const row = getDb().query(`SELECT * FROM scheduler_tasks WHERE id = ?`).get(id) as TaskRow | null;
  return row ? rowToTask(row) : null;
}

export function updateTaskAfterFire(
  id: string,
  newFireAt: string,
  firedCount: number,
  lastFiredAt: string,
): void {
  getDb()
    .query(
      `UPDATE scheduler_tasks
       SET fire_at = ?, fired_count = ?, last_fired_at = ?
       WHERE id = ?`,
    )
    .run(newFireAt, firedCount, lastFiredAt, id);
}

export function deleteTask(id: string): number {
  const result = getDb().query(`DELETE FROM scheduler_tasks WHERE id = ?`).run(id);
  return result.changes;
}

export function setTaskEnabled(id: string, enabled: boolean): void {
  getDb()
    .query(`UPDATE scheduler_tasks SET enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, id);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | "name"
      | "description"
      | "fireAt"
      | "intervalSeconds"
      | "cronExpr"
      | "action"
      | "missedPolicy"
      | "concurrency"
      | "startDeadlineSeconds"
      | "tags"
      | "keepHistory"
      | "outputDir"
    >
  >,
): void {
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) {
    setClauses.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push("description = ?");
    values.push(updates.description);
  }
  if (updates.fireAt !== undefined) {
    setClauses.push("fire_at = ?");
    values.push(updates.fireAt);
  }
  if (updates.intervalSeconds !== undefined) {
    setClauses.push("interval_seconds = ?");
    values.push(updates.intervalSeconds);
  }
  if (updates.cronExpr !== undefined) {
    setClauses.push("cron_expr = ?");
    values.push(updates.cronExpr);
  }
  if (updates.action !== undefined) {
    setClauses.push("action_type = ?");
    values.push(updates.action.type);
    setClauses.push("action_target = ?");
    values.push(updates.action.target);
    setClauses.push("action_payload = ?");
    values.push(updates.action.payload ? JSON.stringify(updates.action.payload) : null);
  }
  if (updates.missedPolicy !== undefined) {
    setClauses.push("missed_policy = ?");
    values.push(updates.missedPolicy);
  }
  if (updates.concurrency !== undefined) {
    setClauses.push("concurrency = ?");
    values.push(updates.concurrency);
  }
  if (updates.startDeadlineSeconds !== undefined) {
    setClauses.push("start_deadline_seconds = ?");
    values.push(updates.startDeadlineSeconds);
  }
  if (updates.tags !== undefined) {
    setClauses.push("tags = ?");
    values.push(JSON.stringify(updates.tags));
  }
  if (updates.keepHistory !== undefined) {
    setClauses.push("keep_history = ?");
    values.push(updates.keepHistory);
  }
  if (updates.outputDir !== undefined) {
    setClauses.push("output_dir = ?");
    values.push(updates.outputDir);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  getDb()
    .query(`UPDATE scheduler_tasks SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...values);
}

// ── Execution History ───────────────────────────────────────

export function insertExecution(exec: {
  id: string;
  taskId: string;
  firedAt: string;
  status: "running" | "success" | "error" | "skipped" | "cancelled";
}): void {
  getDb()
    .query(
      `INSERT INTO scheduler_task_executions (id, task_id, fired_at, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run(exec.id, exec.taskId, exec.firedAt, exec.status);
}

export function completeExecution(
  id: string,
  status: "success" | "error",
  durationMs: number,
  error?: string,
  output?: string,
): void {
  getDb()
    .query(
      `UPDATE scheduler_task_executions
       SET status = ?, completed_at = ?, duration_ms = ?, error = ?, output = ?
       WHERE id = ?`,
    )
    .run(status, new Date().toISOString(), durationMs, error ?? null, output ?? null, id);
}

export function getExecutionsForTask(taskId: string, limit = 50): ExecutionRow[] {
  return getDb()
    .query(
      `SELECT * FROM scheduler_task_executions
       WHERE task_id = ?
       ORDER BY fired_at DESC
       LIMIT ?`,
    )
    .all(taskId, limit) as ExecutionRow[];
}

/**
 * Find the latest running execution for a task. Used by scheduler.update_progress
 * to attach progress messages to the in-flight run when only a taskId is given.
 */
export function getLatestRunningExecution(taskId: string): ExecutionRow | null {
  const row = getDb()
    .query(
      `SELECT * FROM scheduler_task_executions
       WHERE task_id = ? AND status = 'running'
       ORDER BY fired_at DESC
       LIMIT 1`,
    )
    .get(taskId) as ExecutionRow | null;
  return row ?? null;
}

/**
 * Update the progress_message field on an execution row.
 * Identifies the row either by execution id or by (taskId, latest running).
 */
export function updateExecutionProgress(executionId: string, message: string): boolean {
  const result = getDb()
    .query(`UPDATE scheduler_task_executions SET progress_message = ? WHERE id = ?`)
    .run(message, executionId);
  return result.changes > 0;
}

export function pruneExecutions(taskId: string, keepCount: number): void {
  getDb()
    .query(
      `DELETE FROM scheduler_task_executions
       WHERE task_id = ? AND id NOT IN (
         SELECT id FROM scheduler_task_executions
         WHERE task_id = ?
         ORDER BY fired_at DESC
         LIMIT ?
       )`,
    )
    .run(taskId, taskId, keepCount);
}

// ── Migration from JSON ─────────────────────────────────────

export interface LegacyTask {
  id: string;
  name: string;
  description?: string;
  type: "once" | "interval";
  fireAt: string;
  intervalSeconds?: number;
  action: {
    type: "emit" | "extension_call" | "notification" | "exec";
    target: string;
    payload?: Record<string, unknown>;
  };
  enabled: boolean;
  createdAt: string;
  firedCount: number;
}

export function migrateLegacyTasks(legacyTasks: LegacyTask[]): number {
  let count = 0;
  const d = getDb();

  const insertStmt = d.query(
    `INSERT OR IGNORE INTO scheduler_tasks
     (id, name, description, type, fire_at, interval_seconds, cron_expr,
      action_type, action_target, action_payload,
      missed_policy, concurrency, start_deadline_seconds,
      enabled, tags, created_at, fired_count, last_fired_at, keep_history, output_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const task of legacyTasks) {
    const result = insertStmt.run(
      task.id,
      task.name,
      task.description ?? null,
      task.type,
      task.fireAt,
      task.intervalSeconds ?? null,
      null, // cron_expr
      task.action.type,
      task.action.target,
      task.action.payload ? JSON.stringify(task.action.payload) : null,
      "fire_once", // missed_policy default
      "skip_if_running", // concurrency default
      null, // start_deadline_seconds
      task.enabled ? 1 : 0,
      null, // tags
      task.createdAt,
      task.firedCount,
      null, // last_fired_at
      50, // keep_history default
      null, // output_dir
    );
    if (result.changes > 0) count++;
  }

  return count;
}
