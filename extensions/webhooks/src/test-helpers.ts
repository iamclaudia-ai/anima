/**
 * Test helpers: an in-memory database with the real migration applied, and a
 * logger that records what it was told.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoggerLike } from "@anima/shared";

const MIGRATION = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "gateway",
  "migrations",
  "025-webhooks.sql",
);

export function createTestDb(): Database {
  const sql = readFileSync(MIGRATION, "utf8");
  const up = sql.split("-- Down")[0].replace("-- Up", "");
  const db = new Database(":memory:");
  db.exec(up);
  return db;
}

export interface RecordedLog {
  level: "info" | "warn" | "error";
  message: string;
  meta?: unknown;
}

export function createRecordingLogger(): LoggerLike & { entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const logger = {
    entries,
    info(message: string, meta?: unknown) {
      entries.push({ level: "info", message, meta });
    },
    warn(message: string, meta?: unknown) {
      entries.push({ level: "warn", message, meta });
    },
    error(message: string, meta?: unknown) {
      entries.push({ level: "error", message, meta });
    },
    child() {
      return logger;
    },
  };
  return logger;
}
