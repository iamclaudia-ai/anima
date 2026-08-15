/**
 * The migration set has to work on a database that has never been migrated.
 *
 * Nothing tested that, and it stopped being true for five months: two files
 * were numbered 016, `_migrations.id` is a primary key, so a fresh run applied
 * the first, aborted on the second, and silently skipped everything after —
 * no FTS index, no scheduler tables. The one live database had already passed
 * that point, so every day-to-day path looked fine.
 *
 * These tests run the real migration directory. They are the check that a
 * clean install still boots.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { migrate } from "./migrate";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../migrations");

describe("migrations", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-migrate-"));
    db = new Database(join(tempDir, "fresh.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function tableNames(): Set<string> {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  it("applies every migration to a database built from scratch", () => {
    migrate(db);

    const fileCount = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+[.-].*\.sql$/.test(f)).length;
    const applied = db.query("SELECT id, name FROM _migrations ORDER BY id").all() as Array<{
      id: number;
      name: string;
    }>;

    // Every file, not just every file up to the first that fails.
    expect(applied).toHaveLength(fileCount);
  });

  it("produces the tables the extensions actually read", () => {
    migrate(db);
    const tables = tableNames();

    for (const table of [
      "workspaces",
      "sessions",
      "memory_transcript_entries",
      "memory_documents",
      "memory_search_fts",
      "memory_transcript_fts",
      "scheduler_tasks",
    ]) {
      expect({ table, present: tables.has(table) }).toEqual({ table, present: true });
    }
  });

  it("gives workspaces the columns the nav sorts and filters on", () => {
    migrate(db);
    const columns = (
      db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("general");
    expect(columns).toContain("pinned");
  });

  it("gives sessions both status axes, with the widened runtime constraint", () => {
    migrate(db);

    const columns = (db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain("runtime_status");
    expect(columns).toContain("disposition");

    db.query("INSERT INTO workspaces (id, name, cwd) VALUES ('ws', 'ws', '/tmp/ws')").run();
    const insert = db.query(
      `INSERT INTO sessions (workspace_id, provider_session_id, model, runtime_status)
       VALUES ('ws', ?, 'claude-opus-5', ?)`,
    );

    // The states migration 024 exists to allow. A CHECK constraint can't be
    // widened by ALTER TABLE, so this is the assertion that the rebuild ran
    // rather than the column merely existing.
    for (const status of ["awaiting_input", "awaiting_approval"]) {
      expect(() => insert.run(`ses_${status}`, status)).not.toThrow();
    }
    expect(() => insert.run("ses_bogus", "daydreaming")).toThrow();

    // Disposition defaults to open, and is likewise constrained.
    const row = db
      .query("SELECT disposition FROM sessions WHERE provider_session_id = 'ses_awaiting_input'")
      .get() as { disposition: string };
    expect(row.disposition).toBe("open");
    expect(() =>
      db
        .query("UPDATE sessions SET disposition = 'vibes' WHERE provider_session_id = ?")
        .run("ses_awaiting_input"),
    ).toThrow();
  });

  it("is idempotent — a second run applies nothing and changes nothing", () => {
    migrate(db);
    const first = db.query("SELECT id FROM _migrations ORDER BY id").all();

    migrate(db);
    const second = db.query("SELECT id FROM _migrations ORDER BY id").all();

    expect(second).toEqual(first);
  });

  it("refuses a duplicate id instead of silently skipping the rest", () => {
    // The actual failure mode, reproduced: without this guard the second file
    // aborts on a UNIQUE constraint and every later migration is skipped.
    const dir = mkdtempSync(join(tmpdir(), "anima-migrate-dupe-"));
    writeFileSync(join(dir, "001-alpha.sql"), "-- Up\nCREATE TABLE a (x);\n-- Down\nDROP TABLE a;");
    writeFileSync(join(dir, "001-beta.sql"), "-- Up\nCREATE TABLE b (x);\n-- Down\nDROP TABLE b;");

    expect(() => migrate(db, { migrationsPath: dir })).toThrow(/Duplicate migration ids: 1 /);
    expect(tableNames().has("a")).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("names the migration that failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "anima-migrate-bad-"));
    writeFileSync(
      join(dir, "001-broken.sql"),
      "-- Up\nDELETE FROM table_that_is_not_there;\n-- Down\nSELECT 1;",
    );

    expect(() => migrate(db, { migrationsPath: dir })).toThrow(/Migration 1 \(broken\) failed/);

    rmSync(dir, { recursive: true, force: true });
  });
});
