/** In-memory anima.db with the support tables and a minimal workspaces table (tests only). */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function supportTestDb(): Database {
  const sql = readFileSync(
    join(import.meta.dir, "..", "..", "..", "packages", "gateway", "migrations", "029-support.sql"),
    "utf8",
  );
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.exec("INSERT INTO workspaces (id, name) VALUES ('ws_tnh', 'tnh'), ('ws_other', 'other')");
  db.exec(sql.split("-- Down")[0].replace("-- Up", ""));
  return db;
}
