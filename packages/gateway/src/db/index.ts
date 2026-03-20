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

const ANIMA_DIR = join(homedir(), ".anima");
const DB_PATH = join(ANIMA_DIR, "anima.db");

let db: Database | null = null;

/**
 * Get the database singleton. Creates and migrates on first call.
 */
export function getDb(): Database {
  if (db) return db;

  // Ensure ~/.anima/ exists
  if (!existsSync(ANIMA_DIR)) {
    mkdirSync(ANIMA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Run pending migrations
  migrate(db);

  log.info("Opened database", { path: DB_PATH });
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
