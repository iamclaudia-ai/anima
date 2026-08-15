/**
 * Database singleton
 *
 * Opens ~/.anima/anima.db, enables WAL mode, runs migrations.
 * The DB is global since the gateway serves all workspaces.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { migrate } from "./migrate";
import { createLogger } from "@anima/shared";

const log = createLogger("DB", join(homedir(), ".anima", "logs", "gateway.log"));

/**
 * Where the database lives — resolved per call, not at import.
 *
 * This used to be a module constant built from `homedir()`, which meant
 * `ANIMA_DATA_DIR` could not redirect it and no test could avoid it. The
 * gateway integration tests spawn a real gateway with an isolated data dir;
 * that gateway was opening and migrating the **live** `~/.anima/anima.db`
 * anyway. It went unnoticed because the live database was always already
 * migrated — but the same import-time resolution in agent-host's `state.ts` is
 * what let `bun test` truncate the live session registry and kill running CLI
 * panes on 2026-08-15.
 *
 * A test run must not be able to reach the running system's state.
 */
function dataDir(): string {
  return process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
}

let db: Database | null = null;

/**
 * Get the database singleton. Creates and migrates on first call.
 */
export function getDb(): Database {
  if (db) return db;

  const dir = dataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const dbPath = join(dir, "anima.db");
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  // Run pending migrations
  migrate(db);

  log.info("Opened database", { path: dbPath });
  return db;
}

/**
 * Close the database (for graceful shutdown)
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
