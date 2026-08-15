import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, createWorkspace } from "./workspace";
import {
  closeSessionDb,
  getRefsForSessions,
  getSessionDb,
  setSessionRefs,
  upsertSession,
} from "./session-store";
import { backfillSessionRefs, clearRefScanWatermarks, syncSessionRefs } from "./session-ref-sync";
import type { RefsConfig } from "./session-refs";

const config: RefsConfig = {
  linear: { prefixes: ["BEE", "WEB"], workspace: "beehiiv" },
  github: { defaultRepo: "beehiiv/swarm", minDigits: 2 },
};

let dataDir: string;
let prevDataDir: string | undefined;
let workspaceId: string;
let entryId = 0;

/**
 * Stand in for the memory extension's table.
 *
 * Session reads this corpus but doesn't own it, so the test creates it exactly
 * as memory does rather than reaching for a shared migration — if the real
 * shape drifts, this is where it should be noticed.
 */
function createTranscriptTable(db: Database): void {
  db.exec(`
    CREATE TABLE memory_transcript_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source_file TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
      tool_names TEXT, timestamp TEXT NOT NULL, cwd TEXT,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function addEntry(sessionId: string, role: "user" | "assistant", content: string): void {
  entryId++;
  getSessionDb()
    .query(
      `INSERT INTO memory_transcript_entries (session_id, source_file, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      `${sessionId}.jsonl`,
      role,
      content,
      `2026-08-15T00:00:${String(entryId % 60).padStart(2, "0")}Z`,
    );
}

function addSession(sessionId: string, lastActivity = new Date().toISOString()): void {
  upsertSession({
    id: sessionId,
    workspaceId,
    providerSessionId: sessionId,
    model: "claude-opus-5",
    agent: "claude",
    purpose: "chat",
    runtimeStatus: "idle",
    lastActivity,
  });
}

const keysOf = (sessionId: string): string[] =>
  (getRefsForSessions([sessionId]).get(sessionId) ?? []).map((ref) => ref.key);

describe("syncSessionRefs", () => {
  beforeEach(() => {
    prevDataDir = process.env.ANIMA_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "anima-ref-sync-"));
    process.env.ANIMA_DATA_DIR = dataDir;
    closeDb();
    closeSessionDb();
    createTranscriptTable(getSessionDb());
    workspaceId = createWorkspace({ name: "swarm", cwd: join(dataDir, "swarm") }).id;
    entryId = 0;
  });

  afterEach(() => {
    closeDb();
    closeSessionDb();
    if (prevDataDir === undefined) delete process.env.ANIMA_DATA_DIR;
    else process.env.ANIMA_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("picks up refs mentioned mid-conversation, not just in the opening prompt", () => {
    addSession("s1");
    addEntry("s1", "user", "morning babe, let's look at the nav");
    addEntry("s1", "assistant", "That's the same breakage as WEB-5592 — filed as #412.");

    const result = syncSessionRefs(
      [{ sessionId: "s1", titleText: "morning babe, let's look at the nav" }],
      config,
    );

    expect(result.updated).toBe(1);
    // Within one message `extractRefs` emits GitHub refs before Linear ones,
    // regardless of where each appeared in the text.
    expect(keysOf("s1")).toEqual(["beehiiv/swarm#412", "WEB-5592"]);
  });

  test("keeps the opening prompt's ref as the leading chip", () => {
    addSession("s2");
    addEntry("s2", "user", "review BEE-24118 for me");
    addEntry("s2", "assistant", "Related work landed in #900.");

    syncSessionRefs([{ sessionId: "s2", titleText: "review BEE-24118 for me" }], config);

    expect(keysOf("s2")).toEqual(["BEE-24118", "beehiiv/swarm#900"]);
  });

  test("a second pass reads only new entries and leaves an unchanged set alone", () => {
    addSession("s3");
    addEntry("s3", "user", "start on WEB-100");

    const first = syncSessionRefs([{ sessionId: "s3" }], config);
    expect(first.scanned).toBe(1);
    expect(first.updated).toBe(1);

    // Nothing new — the watermark means there is nothing to re-read, so no
    // write happens either.
    const second = syncSessionRefs(
      [{ sessionId: "s3", currentRefs: getRefsForSessions(["s3"]).get("s3") }],
      config,
    );
    expect(second.scanned).toBe(0);
    expect(second.updated).toBe(0);

    addEntry("s3", "assistant", "opened #55 for it");
    const third = syncSessionRefs(
      [{ sessionId: "s3", currentRefs: getRefsForSessions(["s3"]).get("s3") }],
      config,
    );
    expect(third.scanned).toBe(1);
    expect(keysOf("s3")).toEqual(["WEB-100", "beehiiv/swarm#55"]);
  });

  test("refs already on the row survive a pass that re-reads nothing", () => {
    addSession("s4");
    setSessionRefs("s4", [{ type: "linear", key: "BEE-1", label: "BEE-1" }]);
    addEntry("s4", "user", "and also #77");

    syncSessionRefs(
      [{ sessionId: "s4", currentRefs: getRefsForSessions(["s4"]).get("s4") }],
      config,
    );

    expect(keysOf("s4")).toEqual(["BEE-1", "beehiiv/swarm#77"]);
  });

  test("dryRun reports without writing, and without burning the watermark", () => {
    addSession("s5");
    addEntry("s5", "user", "fix WEB-7");

    const dry = syncSessionRefs([{ sessionId: "s5" }], config, { dryRun: true });
    expect(dry.updated).toBe(1);
    expect(keysOf("s5")).toEqual([]);

    const wet = syncSessionRefs([{ sessionId: "s5" }], config);
    expect(wet.updated).toBe(1);
    expect(keysOf("s5")).toEqual(["WEB-7"]);
  });

  test("rescan replaces refs rather than merging, so config changes take effect", () => {
    addSession("s6");
    addEntry("s6", "user", "ENT-9 and WEB-9");

    // ENT is a configured prefix at first...
    syncSessionRefs([{ sessionId: "s6" }], {
      ...config,
      linear: { prefixes: ["ENT", "WEB"], workspace: "beehiiv" },
    });
    expect(keysOf("s6")).toEqual(["ENT-9", "WEB-9"]);

    // ...and then isn't. A plain pass can't withdraw it — the entries are
    // behind the watermark — but a rescan re-reads and replaces.
    clearRefScanWatermarks(["s6"]);
    syncSessionRefs(
      [{ sessionId: "s6", currentRefs: getRefsForSessions(["s6"]).get("s6") }],
      config,
      { rescan: true },
    );
    expect(keysOf("s6")).toEqual(["WEB-9"]);
  });

  test("survives a database where memory has never ingested", () => {
    getSessionDb().exec("DROP TABLE memory_transcript_entries");
    addSession("s7");

    const result = syncSessionRefs([{ sessionId: "s7", titleText: "look at WEB-3" }], config);

    expect(result.updated).toBe(1);
    expect(keysOf("s7")).toEqual(["WEB-3"]);
  });
});

describe("backfillSessionRefs", () => {
  beforeEach(() => {
    prevDataDir = process.env.ANIMA_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "anima-ref-backfill-"));
    process.env.ANIMA_DATA_DIR = dataDir;
    closeDb();
    closeSessionDb();
    createTranscriptTable(getSessionDb());
    workspaceId = createWorkspace({ name: "swarm", cwd: join(dataDir, "swarm") }).id;
    entryId = 0;
  });

  afterEach(() => {
    closeDb();
    closeSessionDb();
    if (prevDataDir === undefined) delete process.env.ANIMA_DATA_DIR;
    else process.env.ANIMA_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("covers sessions inside the window and skips older ones", () => {
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();

    addSession("recent", recent);
    addEntry("recent", "assistant", "shipped in #321");
    addSession("old", old);
    addEntry("old", "assistant", "shipped in #999");

    const result = backfillSessionRefs(() => config, { days: 30 });

    expect(result.sessions).toBe(1);
    expect(keysOf("recent")).toEqual(["beehiiv/swarm#321"]);
    expect(keysOf("old")).toEqual([]);
  });

  test("drains a conversation longer than one pass's read budget", () => {
    addSession("long");
    for (let i = 0; i < 700; i++) addEntry("long", "user", `message ${i} with nothing in it`);
    addEntry("long", "assistant", "and finally, BEE-42");

    const result = backfillSessionRefs(() => config, { days: 30 });

    expect(result.scanned).toBe(701);
    expect(keysOf("long")).toEqual(["BEE-42"]);
  });
});
