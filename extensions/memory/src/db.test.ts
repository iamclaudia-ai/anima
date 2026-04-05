import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDbPathForTests, upsertConversation } from "./db";

function setupSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_file_states (file_path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_transcript_entries (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE IF NOT EXISTS memory_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      source_file TEXT,
      first_message_at TEXT,
      last_message_at TEXT,
      entry_count INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      strategy TEXT,
      summary TEXT,
      processed_at TEXT,
      status_at TEXT,
      metadata TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_state_machines (
      machine_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      process_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_file_locks (
      source_file TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      locked_at TEXT NOT NULL DEFAULT (datetime('now')),
      locked_by_pid INTEGER NOT NULL,
      locked_by_machine TEXT
    );
  `);
}

describe("memory conversation upsert", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-memory-upsert-"));
    setDbPathForTests(join(tempDir, "anima.test.db"));
    setupSchema();
  });

  afterEach(() => {
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not recreate conversations already archived for the same exact range", () => {
    const db = getDb();
    db.query(
      `INSERT INTO memory_conversations
        (session_id, source_file, first_message_at, last_message_at, entry_count, status)
       VALUES (?, ?, ?, ?, ?, 'archived')`,
    ).run("s1", "file-a.jsonl", "2026-03-01T10:00:00.000Z", "2026-03-01T10:30:00.000Z", 20);

    upsertConversation({
      sessionId: "s1",
      sourceFile: "file-a.jsonl",
      firstMessageAt: "2026-03-01T10:00:00.000Z",
      lastMessageAt: "2026-03-01T10:30:00.000Z",
      entryCount: 20,
    });

    const count = db
      .query(
        `SELECT count(*) as n
         FROM memory_conversations
         WHERE source_file = ? AND first_message_at = ? AND last_message_at = ?`,
      )
      .get("file-a.jsonl", "2026-03-01T10:00:00.000Z", "2026-03-01T10:30:00.000Z") as {
      n: number;
    };

    expect(count.n).toBe(1);
  });

  it("creates a new active conversation when an archived one has a different end time", () => {
    const db = getDb();
    db.query(
      `INSERT INTO memory_conversations
        (session_id, source_file, first_message_at, last_message_at, entry_count, status)
       VALUES (?, ?, ?, ?, ?, 'archived')`,
    ).run("s1", "file-b.jsonl", "2026-03-01T10:00:00.000Z", "2026-03-01T10:30:00.000Z", 20);

    upsertConversation({
      sessionId: "s1",
      sourceFile: "file-b.jsonl",
      firstMessageAt: "2026-03-01T10:00:00.000Z",
      lastMessageAt: "2026-03-01T10:45:00.000Z",
      entryCount: 24,
    });

    const rows = db
      .query(
        `SELECT status, last_message_at AS lastMessageAt, entry_count AS entryCount
         FROM memory_conversations
         WHERE source_file = ? AND first_message_at = ?
         ORDER BY id ASC`,
      )
      .all("file-b.jsonl", "2026-03-01T10:00:00.000Z") as Array<{
      status: string;
      lastMessageAt: string;
      entryCount: number;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: "archived",
      lastMessageAt: "2026-03-01T10:30:00.000Z",
      entryCount: 20,
    });
    expect(rows[1]).toMatchObject({
      status: "active",
      lastMessageAt: "2026-03-01T10:45:00.000Z",
      entryCount: 24,
    });
  });
});
