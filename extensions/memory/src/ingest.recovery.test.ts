import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, rollbackStuckFile, setDbPathForTests } from "./db";

describe("ingest crash recovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-memory-recovery-"));
    setDbPathForTests(join(tempDir, "anima.test.db"));

    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_file_states (
        file_path TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','ingesting')),
        last_modified INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        last_processed_offset INTEGER NOT NULL DEFAULT 0,
        last_committed_entry_id INTEGER,
        last_entry_timestamp TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS memory_transcript_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_names TEXT,
        timestamp TEXT NOT NULL,
        cwd TEXT,
        ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rolls back only entries after committed id when timestamps collide", () => {
    const db = getDb();
    const sourceFile = "foo/session.jsonl";
    const ts = "2026-01-01T00:00:00.000Z";

    const insert = db.prepare(
      `INSERT INTO memory_transcript_entries (session_id, source_file, role, content, timestamp)
       VALUES (?, ?, 'assistant', ?, ?)`,
    );

    insert.run("s1", sourceFile, "older-1", ts); // id=1
    insert.run("s1", sourceFile, "older-2", ts); // id=2 (last committed)
    insert.run("s1", sourceFile, "partial-1", ts); // id=3 (partial)
    insert.run("s1", sourceFile, "partial-2", ts); // id=4 (partial)

    const deleted = rollbackStuckFile(sourceFile, 2, ts);
    expect(deleted).toBe(2);

    const rows = db
      .query(
        `SELECT id, content FROM memory_transcript_entries WHERE source_file = ? ORDER BY id ASC`,
      )
      .all(sourceFile) as Array<{ id: number; content: string }>;

    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.map((r) => r.content)).toEqual(["older-1", "older-2"]);
  });
});
