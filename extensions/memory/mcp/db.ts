/**
 * Memory MCP — Read-only Database Connection
 *
 * Opens a read-only SQLite connection to ~/.anima/anima.db
 * for FTS5 full-text search queries. Falls back gracefully
 * if the database or FTS table doesn't exist yet.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const DB_PATH = join(homedir(), ".anima", "anima.db");

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
// ============================================================================
// Transcript Lookup
// ============================================================================

export interface TranscriptEntry {
  role: string;
  content: string;
  timestamp: string;
  toolNames: string | null;
  cwd: string | null;
}

export interface ConversationInfo {
  id: number;
  sessionId: string;
  sourceFile: string;
  firstMessageAt: string;
  lastMessageAt: string;
  cwd: string | null;
  summary: string | null;
  entryCount: number;
}

/**
 * Get conversation metadata by ID.
 */
export function getConversation(conversationId: number): ConversationInfo | null {
  const d = getDb();
  if (!d) return null;

  try {
    return d
      .query(
        `SELECT
          id, session_id AS sessionId, source_file AS sourceFile,
          first_message_at AS firstMessageAt, last_message_at AS lastMessageAt,
          json_extract(metadata, '$.cwd') AS cwd,
          summary, entry_count AS entryCount
        FROM memory_conversations
        WHERE id = ?`,
      )
      .get(conversationId) as ConversationInfo | null;
  } catch {
    return null;
  }
}

/**
 * Get transcript entries for a conversation by its ID.
 * Uses the conversation's source_file and time range to find entries.
 */
export function getTranscript(
  conversationId: number,
  opts?: { limit?: number },
): { conversation: ConversationInfo; entries: TranscriptEntry[] } | null {
  const d = getDb();
  if (!d) return null;

  const conv = getConversation(conversationId);
  if (!conv) return null;

  const limit = opts?.limit ?? 500;

  try {
    const entries = d
      .query(
        `SELECT role, content, timestamp, tool_names AS toolNames, cwd
        FROM memory_transcript_entries
        WHERE source_file = ?
          AND timestamp >= ?
          AND timestamp <= ?
          AND tool_names IS NULL
        ORDER BY timestamp
        LIMIT ?`,
      )
      .all(conv.sourceFile, conv.firstMessageAt, conv.lastMessageAt, limit) as TranscriptEntry[];

    return { conversation: conv, entries };
  } catch {
    return null;
  }
}

/**
 * Extract conversation ID from an episode source_id.
 * Episode files are named: YYYY-MM-DD-HHMM-{convId}.md
 * Returns null if the ID can't be extracted.
 */
export function extractConversationId(sourceId: string): number | null {
  // Match the conv ID from filename like 2026-03-17-0832-77396.md
  const match = sourceId.match(/(\d+)\.md$/);
  if (!match) return null;
  const id = parseInt(match[1]);
  return isNaN(id) ? null : id;
}

// ============================================================================
// FTS Search
// ============================================================================

export function searchFts(
  query: string,
  opts?: { limit?: number; category?: string; dateFrom?: string; dateTo?: string },
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

    if (opts?.dateFrom) {
      conditions.push("timestamp >= ?");
      params.push(opts.dateFrom);
    }

    if (opts?.dateTo) {
      conditions.push("timestamp <= ?");
      params.push(opts.dateTo);
    }

    params.push(limit);

    const whereClause = conditions.join(" AND ");

    return d
      .query(
        `SELECT
          content, source_type AS sourceType, source_id AS sourceId,
          cwd, timestamp, category,
          CASE
            WHEN source_id LIKE '%/index.md' THEN rank * 2.0
            ELSE rank
          END AS rank
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
