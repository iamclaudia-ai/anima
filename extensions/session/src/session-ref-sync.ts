/**
 * Keep a session's PR / ticket chips in step with its **whole conversation**.
 *
 * Refs were originally derived from the opening prompt alone, which covers the
 * common case — you usually name the PR you're about to work on — but misses
 * every reference that shows up later: a ticket id Michael pastes in message
 * 40, a PR number I create mid-session and report back. Roughly 40% of
 * sessions in this workspace mention a ref somewhere other than the first
 * message.
 *
 * ## Where the text comes from
 *
 * `memory_transcript_entries`, not the JSONL. That table already holds parsed
 * user *and* assistant prose for every session in the same `anima.db`, updated
 * incrementally within seconds of a message landing, and it is never pruned —
 * so it outlives the transcripts Claude Code deletes after ~30 days. Re-parsing
 * the JSONL here would mean a second parser, a second read of every file on
 * every sweep, and no coverage of sessions whose transcript is already gone.
 *
 * The known gap is inherited from that corpus: tool inputs and outputs aren't
 * stored (assistant tool calls appear as `[Used tools: Bash]`), so a PR number
 * that only ever appeared in `gh pr create` output isn't matched. In practice
 * refs live in prose — the prompt that asks for the work and the reply that
 * reports it — which is exactly what is indexed.
 *
 * ## Why it's incremental
 *
 * Reconcile runs on every list call. Re-reading a session's full history each
 * pass would put a 200k-row scan on the nav's critical path, so each session
 * carries a watermark — the highest transcript entry id already scanned — and
 * a steady-state pass reads only the handful of messages since.
 *
 * The cost of that choice: refs accumulate and are never withdrawn. A ref seen
 * once stays on the row even if the config that matched it changes, because
 * the messages that produced it are behind the watermark. `rescan` exists for
 * exactly that case — it resets the watermarks and rebuilds from the whole
 * conversation.
 */

import { createLogger } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RefsConfig, SessionRef } from "./session-refs";
import { extractRefs, extractRefsFromTexts, mergeRefs } from "./session-refs";
import {
  getSessionDb,
  listSessionsForRefSync,
  setSessionRefs,
  type StoredSessionRef,
} from "./session-store";

const log = createLogger("SessionExt:RefSync", join(homedir(), ".anima", "logs", "session.log"));

/**
 * Entries read per session per pass.
 *
 * Bounds the first scan of a long session so it can't stall a nav render;
 * whatever is left stays behind the watermark and is picked up by the next
 * sweep. Backfill passes `drain` to loop instead.
 */
const MAX_ENTRIES_PER_PASS = 500;

/** SQLite's default parameter ceiling is 999 — chunk `IN (...)` well under it. */
const ID_CHUNK = 400;

export interface RefSyncInput {
  sessionId: string;
  /** Opening prompt or stored title — the session's subject line. */
  titleText?: string;
  /** Refs already on the row, so an unchanged set skips the write. */
  currentRefs?: readonly StoredSessionRef[];
}

export interface RefSyncResult {
  /** Sessions whose ref set changed. */
  updated: number;
  /** Refs added across those sessions. */
  added: number;
  /** Transcript entries read this pass. */
  scanned: number;
}

interface ScanOptions {
  /** Keep reading until every session's transcript is exhausted. */
  drain?: boolean;
  /** Ignore stored watermarks and re-read each session from the beginning. */
  rescan?: boolean;
  /** Compute everything, write nothing. */
  dryRun?: boolean;
}

/**
 * Keyed by connection rather than a plain boolean: the database can be closed
 * and reopened within a process (tests, and `closeSessionDb` on reload), and a
 * flag would then claim a table exists in a connection that has never seen it.
 */
const scanTableReady = new WeakSet<object>();

/**
 * Watermark table — session extension's own, sitting next to `session_refs`.
 *
 * Deliberately separate from `sessions.metadata_json`: this is written on a
 * hot path far more often than session metadata, and a JSON read-modify-write
 * per session per sweep would be both slower and a lost-update risk against
 * the reconciler's own upserts.
 */
function ensureScanTable(): void {
  const db = getSessionDb();
  if (scanTableReady.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_ref_scan (
      session_id    TEXT PRIMARY KEY,
      last_entry_id INTEGER NOT NULL DEFAULT 0,
      scanned_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  scanTableReady.add(db);
}

/**
 * Whether memory's transcript corpus exists yet.
 *
 * `memory_transcript_entries` belongs to the memory extension. It shares this
 * database, but session must not assume it — memory can be disabled, or simply
 * not have started yet on a first run — and a missing table would otherwise
 * throw straight through the nav's list call. Without it, refs fall back to
 * the opening prompt, which is what they were before this path existed.
 *
 * Not cached: the table appears when memory first ingests, and a process that
 * cached `false` at startup would never pick refs up again.
 */
function hasTranscriptCorpus(): boolean {
  const row = getSessionDb()
    .query(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get("memory_transcript_entries") as { present: number } | null;
  return row !== null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Sessions with transcript entries past their watermark, and how far they run.
 *
 * One aggregate query for the whole page rather than a probe per session —
 * a steady-state sweep over a 250-session workspace usually returns zero rows,
 * which is what keeps this off the nav's critical path.
 */
function findSessionsWithNewEntries(
  sessionIds: readonly string[],
  rescan: boolean,
): Map<string, number> {
  const watermarks = new Map<string, number>();
  const db = getSessionDb();

  for (const ids of chunk(sessionIds, ID_CHUNK)) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT e.session_id AS session_id,
                MAX(e.id)     AS max_id,
                ${rescan ? "0" : "COALESCE(w.last_entry_id, 0)"} AS watermark
           FROM memory_transcript_entries e
           LEFT JOIN session_ref_scan w ON w.session_id = e.session_id
          WHERE e.session_id IN (${placeholders})
          GROUP BY e.session_id
         HAVING max_id > watermark`,
      )
      .all(...ids) as Array<{ session_id: string; max_id: number; watermark: number }>;

    for (const row of rows) watermarks.set(row.session_id, row.watermark);
  }

  return watermarks;
}

interface EntryBatch {
  texts: string[];
  lastEntryId: number;
  exhausted: boolean;
}

function readEntriesAfter(sessionId: string, afterId: number, limit: number): EntryBatch {
  const rows = getSessionDb()
    .query(
      `SELECT id, content
         FROM memory_transcript_entries
        WHERE session_id = ? AND id > ?
        ORDER BY id
        LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as Array<{ id: number; content: string }>;

  return {
    texts: rows.map((row) => row.content).filter(Boolean),
    lastEntryId: rows.length > 0 ? (rows[rows.length - 1]?.id ?? afterId) : afterId,
    exhausted: rows.length < limit,
  };
}

function recordWatermark(sessionId: string, lastEntryId: number): void {
  getSessionDb()
    .query(
      `INSERT INTO session_ref_scan (session_id, last_entry_id, scanned_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE
         SET last_entry_id = excluded.last_entry_id, scanned_at = excluded.scanned_at`,
    )
    .run(sessionId, lastEntryId);
}

/** Reset watermarks so the next pass re-reads these sessions in full. */
export function clearRefScanWatermarks(sessionIds: readonly string[]): void {
  ensureScanTable();
  const db = getSessionDb();
  for (const ids of chunk(sessionIds, ID_CHUNK)) {
    const placeholders = ids.map(() => "?").join(",");
    db.query(`DELETE FROM session_ref_scan WHERE session_id IN (${placeholders})`).run(...ids);
  }
}

function toStored(refs: readonly SessionRef[]): StoredSessionRef[] {
  return refs.map((ref) => ({ type: ref.type, key: ref.key, label: ref.label, url: ref.url }));
}

function keysOf(refs: readonly { key: string }[]): string {
  return refs.map((ref) => ref.key).join(" ");
}

/**
 * Derive each session's refs from its title text plus any transcript entries
 * not yet scanned, and persist the ones that changed.
 *
 * Title-derived refs lead, so the session's subject keeps the first chip.
 * Existing refs are preserved rather than replaced — the transcript read is
 * incremental, so a ref's absence from this pass is not evidence it's gone.
 */
export function syncSessionRefs(
  sessions: readonly RefSyncInput[],
  config: RefsConfig,
  options: ScanOptions = {},
): RefSyncResult {
  const result: RefSyncResult = { updated: 0, added: 0, scanned: 0 };
  if (sessions.length === 0) return result;

  ensureScanTable();

  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const next = new Map<string, SessionRef[]>();

  // 1. Subject line — the opening prompt or the stored title. Cheap, and the
  //    only source for sessions memory never ingested (Libby's own, or ones
  //    too new for the ingest to have caught up).
  for (const session of sessions) {
    if (!session.titleText) continue;
    const refs = extractRefs(session.titleText, config);
    if (refs.length > 0) next.set(session.sessionId, refs);
  }

  // 2. Conversation body, incrementally.
  const pending = hasTranscriptCorpus()
    ? findSessionsWithNewEntries([...byId.keys()], options.rescan ?? false)
    : new Map<string, number>();
  for (const [sessionId, watermark] of pending) {
    let cursor = options.rescan ? 0 : watermark;
    let found: SessionRef[] = [];

    for (;;) {
      const batch = readEntriesAfter(sessionId, cursor, MAX_ENTRIES_PER_PASS);
      if (batch.texts.length === 0 && batch.lastEntryId === cursor) break;
      result.scanned += batch.texts.length;
      found = mergeRefs(found, extractRefsFromTexts(batch.texts, config));
      cursor = batch.lastEntryId;
      if (batch.exhausted || !options.drain) break;
    }

    if (found.length > 0) {
      next.set(sessionId, mergeRefs(next.get(sessionId) ?? [], found));
    }
    // The watermark advances even when nothing matched — those messages have
    // been examined, and re-reading them would never produce a different answer.
    if (!options.dryRun && cursor > watermark) recordWatermark(sessionId, cursor);
  }

  // A rescan read every message, so a session that produced nothing this time
  // genuinely has no refs — clear it rather than leaving stale chips behind.
  // Incremental passes can't conclude that, which is why this is rescan-only.
  if (options.rescan) {
    for (const session of sessions) {
      if (next.has(session.sessionId) || !session.currentRefs?.length) continue;
      result.updated++;
      result.added -= session.currentRefs.length;
      if (!options.dryRun) setSessionRefs(session.sessionId, []);
    }
  }

  // 3. Persist only genuine changes. Reconcile runs on every list call, and
  //    rewriting an identical set would be a DELETE + INSERT per session per
  //    keystroke of navigation.
  for (const [sessionId, derived] of next) {
    const current = byId.get(sessionId)?.currentRefs ?? [];
    const derivedStored = toStored(derived);
    // A rescan is authoritative: it read the whole conversation, so a ref that
    // no longer matches should actually disappear.
    const merged = options.rescan
      ? derivedStored
      : mergeRefs<StoredSessionRef>(current, derivedStored);
    if (keysOf(merged) === keysOf(current)) continue;

    result.updated++;
    result.added += merged.length - current.length;
    if (!options.dryRun) setSessionRefs(sessionId, merged);
  }

  if (result.updated > 0) {
    log.info("Session refs updated", {
      sessions: result.updated,
      added: result.added,
      scanned: result.scanned,
      dryRun: options.dryRun ?? false,
    });
  }

  return result;
}

export interface BackfillOptions {
  /** How far back to look, by session last-activity. */
  days?: number;
  /** Re-read whole conversations instead of resuming from the watermark. */
  rescan?: boolean;
  /** Report what would change without writing. */
  dryRun?: boolean;
}

export interface BackfillResult extends RefSyncResult {
  sessions: number;
  workspaces: number;
  since: string;
}

/**
 * One-shot sweep over recent sessions, reading each conversation to the end.
 *
 * Sessions predate this extraction path, so their chips only ever reflected an
 * opening prompt. This is what closes that gap. Going forward the reconciler
 * keeps up incrementally, so this is a migration tool rather than something to
 * run on a schedule — `rescan` aside, a second run is nearly a no-op because
 * every session's watermark is already at the end of its transcript.
 *
 * Config is resolved per workspace, not once: a bare `#412` means a different
 * repository in `beehiiv` than it does in `anima`, and the workspace's own git
 * remote is what disambiguates it.
 */
export function backfillSessionRefs(
  resolveConfig: (cwd: string) => RefsConfig,
  options: BackfillOptions = {},
): BackfillResult {
  const days = options.days ?? 30;
  // Date-only cutoff on purpose. `last_activity` holds two formats — SQLite's
  // `YYYY-MM-DD HH:MM:SS` for rows the DB defaulted, ISO-8601 with a `T` for
  // rows the reconciler wrote — and `T` sorts after a space, so a cutoff with a
  // time component compares inconsistently between them. A bare date is
  // unambiguous against both, at the cost of including the whole cutoff day.
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const sessions = listSessionsForRefSync(since, { corpusAvailable: hasTranscriptCorpus() });

  const byWorkspace = new Map<string, RefSyncInput[]>();
  for (const session of sessions) {
    const list = byWorkspace.get(session.cwd) ?? [];
    list.push({
      sessionId: session.sessionId,
      titleText: session.titleText,
      currentRefs: session.refs,
    });
    byWorkspace.set(session.cwd, list);
  }

  if (options.rescan) {
    clearRefScanWatermarks(sessions.map((session) => session.sessionId));
  }

  const total: BackfillResult = {
    updated: 0,
    added: 0,
    scanned: 0,
    sessions: sessions.length,
    workspaces: byWorkspace.size,
    since,
  };

  for (const [cwd, inputs] of byWorkspace) {
    const pass = syncSessionRefs(inputs, resolveConfig(cwd), {
      drain: true,
      rescan: options.rescan,
      dryRun: options.dryRun,
    });
    total.updated += pass.updated;
    total.added += pass.added;
    total.scanned += pass.scanned;
  }

  log.info("Ref backfill complete", { ...total, dryRun: options.dryRun ?? false });
  return total;
}
