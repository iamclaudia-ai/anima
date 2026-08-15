/**
 * Exercises the real FTS5 external-content index and the migration's triggers,
 * not a stand-in. The parts most likely to break — which message a session's
 * snippet comes from, and whether a delete leaves the index consistent — only
 * exist inside SQLite.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDbPathForTests, searchTranscripts, transcriptFtsExists } from "./db";

/** The migration itself, so the triggers under test are the shipped ones. */
const MIGRATION = join(
  import.meta.dir,
  "../../../packages/gateway/migrations/023-transcript-fts.sql",
);

function applyMigrationUp(): void {
  const sql = readFileSync(MIGRATION, "utf8");
  const up = sql.slice(0, sql.indexOf("-- Down"));
  getDb().exec(up);
}

let nextId = 1;
function insertEntry(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  opts?: { cwd?: string; timestamp?: string },
): number {
  const id = nextId++;
  getDb()
    .query(
      `INSERT INTO memory_transcript_entries (id, session_id, source_file, role, content, timestamp, cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionId,
      `${sessionId}.jsonl`,
      role,
      content,
      opts?.timestamp ?? "2026-08-15T10:00:00Z",
      opts?.cwd ?? "/w/anima",
    );
  return id;
}

/**
 * Rows the *index* holds for a term.
 *
 * A plain `SELECT count(*) FROM memory_transcript_fts` reads straight through
 * to the content table — for an external-content index that counts every
 * entry, indexed or not, which is exactly the distinction these tests are
 * about. Only a MATCH consults the index.
 */
function matchCount(match: string): number {
  return (
    getDb()
      .query("SELECT count(*) AS n FROM memory_transcript_fts WHERE memory_transcript_fts MATCH ?")
      .get(match) as { n: number }
  ).n;
}

describe("transcript search", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudia-transcript-fts-"));
    setDbPathForTests(join(tempDir, "test.db"));
    nextId = 1;
    getDb().exec(`
      CREATE TABLE memory_transcript_entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        tool_names TEXT,
        timestamp  TEXT NOT NULL,
        cwd        TEXT
      );
    `);
    applyMigrationUp();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports the index as present once the migration has run", () => {
    expect(transcriptFtsExists()).toBe(true);
  });

  it("indexes new messages through the trigger", () => {
    insertEntry("ses_a", "user", "why did the proxy port drift after a restart?");

    const hits = searchTranscripts('"proxy" AND "port"');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe("ses_a");
    expect(hits[0]?.role).toBe("user");
    expect(hits[0]?.snippet).toContain("«proxy»");
  });

  it("skips the tool-call placeholder that is over half the corpus", () => {
    insertEntry("ses_a", "assistant", "[Used tools: Bash, Read]");
    insertEntry("ses_a", "assistant", "short");
    expect(matchCount('"tools"')).toBe(0);
    expect(matchCount('"short"')).toBe(0);

    // …but a user message is indexed whatever its length, because a two-word
    // prompt is still the thing you'd search for.
    insertEntry("ses_a", "user", "ship it");
    expect(matchCount('"ship"')).toBe(1);
  });

  it("takes the snippet from the best-matching message, not the newest", () => {
    insertEntry("ses_a", "user", "morning babe, how's the weather", {
      timestamp: "2026-08-15T09:00:00Z",
    });
    insertEntry("ses_a", "assistant", "the reconciler watermark is what keeps the sweep cheap", {
      timestamp: "2026-08-15T10:00:00Z",
    });
    insertEntry("ses_a", "user", "thanks, that's lovely", { timestamp: "2026-08-15T11:00:00Z" });

    const hits = searchTranscripts('"watermark"');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("«watermark»");
    expect(hits[0]?.role).toBe("assistant");
    // The row's timestamp is the latest *match*, so a session sorted by it
    // reads as "when this topic was last discussed".
    expect(hits[0]?.timestamp).toBe("2026-08-15T10:00:00Z");
  });

  it("groups many matching messages into one row per session", () => {
    for (let i = 0; i < 4; i++) insertEntry("ses_a", "user", `watermark question ${i}`);
    insertEntry("ses_b", "user", "watermark question elsewhere");

    const hits = searchTranscripts('"watermark"');
    expect(hits).toHaveLength(2);
    expect(hits.find((h) => h.sessionId === "ses_a")?.matches).toBe(4);
    expect(hits.find((h) => h.sessionId === "ses_b")?.matches).toBe(1);
  });

  it("filters by workspace and date", () => {
    insertEntry("ses_a", "user", "proxy port drift", { cwd: "/w/anima" });
    insertEntry("ses_b", "user", "proxy port drift", { cwd: "/w/beehiiv" });
    insertEntry("ses_c", "user", "proxy port drift", {
      cwd: "/w/anima",
      timestamp: "2025-01-01T00:00:00Z",
    });

    expect(searchTranscripts('"proxy"', { cwd: "/w/beehiiv" }).map((h) => h.sessionId)).toEqual([
      "ses_b",
    ]);
    expect(
      searchTranscripts('"proxy"', { dateFrom: "2026-01-01" })
        .map((h) => h.sessionId)
        .sort(),
    ).toEqual(["ses_a", "ses_b"]);
  });

  it("treats an empty session allow-list as 'nothing qualifies'", () => {
    insertEntry("ses_a", "user", "proxy port drift");

    expect(searchTranscripts('"proxy"', { sessionIds: [] })).toEqual([]);
    expect(searchTranscripts('"proxy"', { sessionIds: ["ses_a"] })).toHaveLength(1);
    expect(searchTranscripts('"proxy"', { sessionIds: ["ses_other"] })).toEqual([]);
  });

  it("drops a message from the index when its entry is deleted", () => {
    // Re-import and crash rollback both delete by source_file. An external
    // content index that kept stale rows would return snippets for messages
    // that no longer exist.
    insertEntry("ses_a", "user", "proxy port drift");
    insertEntry("ses_a", "assistant", "[Used tools: Bash]");
    expect(matchCount('"proxy"')).toBe(1);

    getDb().query("DELETE FROM memory_transcript_entries WHERE source_file = ?").run("ses_a.jsonl");

    expect(matchCount('"proxy"')).toBe(0);
    expect(searchTranscripts('"proxy"')).toEqual([]);
    // The unindexed placeholder was deleted too. Its trigger must have stayed
    // silent — a 'delete' for a row never inserted corrupts an external content
    // index, and integrity-check is the only thing that would catch it.
    expect(() =>
      getDb()
        .query(
          "INSERT INTO memory_transcript_fts(memory_transcript_fts) VALUES ('integrity-check')",
        )
        .run(),
    ).not.toThrow();
  });

  it("survives a delete-and-reinsert cycle with the index intact", () => {
    insertEntry("ses_a", "user", "proxy port drift");
    getDb().query("DELETE FROM memory_transcript_entries WHERE source_file = ?").run("ses_a.jsonl");
    insertEntry("ses_a", "user", "proxy port drift, re-imported");

    const hits = searchTranscripts('"proxy"');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("re-imported");
  });
});
