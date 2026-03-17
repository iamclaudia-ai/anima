/**
 * Memory MCP — Read-only Database Connection
 *
 * Opens a read-only SQLite connection to ~/.claudia/claudia.db
 * for FTS5 full-text search queries. Falls back gracefully
 * if the database or FTS table doesn't exist yet.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const DB_PATH = join(homedir(), ".claudia", "claudia.db");

let db: Database | null = null;

function getDb(): Database | null {
  if (db) return db;

  if (!existsSync(DB_PATH)) return null;

  try {
    db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 3000");
    return db;
  } catch {
    return null;
  }
}

export interface FtsSearchResult {
  content: string;
  sourceType: string;
  sourceId: string;
  cwd: string;
  timestamp: string;
  category: string;
  rank: number;
}

/**
 * Check if the FTS5 table exists in the database.
 */
export function hasFtsTable(): boolean {
  const d = getDb();
  if (!d) return false;

  try {
    d.query("SELECT count(*) FROM memory_search_fts LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Full-text search using FTS5 with BM25 ranking.
 * Returns results sorted by relevance.
 */
export function searchFts(
  query: string,
  opts?: { limit?: number; category?: string },
): FtsSearchResult[] {
  const d = getDb();
  if (!d) return [];

  const limit = opts?.limit ?? 10;

  try {
    const conditions: string[] = ["memory_search_fts MATCH ?"];
    const params: (string | number)[] = [query];

    if (opts?.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }

    params.push(limit);

    const whereClause = conditions.join(" AND ");

    return d
      .query(
        `SELECT
          content, source_type AS sourceType, source_id AS sourceId,
          cwd, timestamp, category, rank
        FROM memory_search_fts
        WHERE ${whereClause}
        ORDER BY rank
        LIMIT ?`,
      )
      .all(...params) as FtsSearchResult[];
  } catch {
    return [];
  }
}
