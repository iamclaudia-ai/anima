/**
 * Memory Extension — Conversation Grouping & Gap Detection
 *
 * Groups transcript entries into conversations by detecting time gaps.
 * Conversations are scoped to source files — entries from different files
 * never merge, even if timestamps overlap (parallel sessions).
 */

import {
  getDb,
  upsertConversation,
  deleteActiveConversationsForFile,
  markConversationsReady,
  updateConversationStatus,
} from "./db";

interface ConversationSegment {
  sessionId: string;
  sourceFile: string;
  firstMessageAt: string;
  lastMessageAt: string;
  entryCount: number;
  /** True if this segment was closed because it hit entry/size limits (not the final/active segment) */
  complete: boolean;
}

/** Max entries per conversation segment */
const MAX_ENTRIES_PER_SEGMENT = 200;
/** Max transcript size per segment (bytes) — ~80KB leaves room for system prompt + tools */
const MAX_SEGMENT_BYTES = 80 * 1024;

/**
 * Split entries into conversation segments based on time gaps,
 * entry count, and cumulative message size.
 */
function segmentByGaps(
  sessionId: string,
  sourceFile: string,
  entries: Array<{ timestamp: string; messageSize: number }>,
  gapMinutes: number,
): ConversationSegment[] {
  if (entries.length === 0) return [];

  const gapMs = gapMinutes * 60 * 1000;
  const segments: ConversationSegment[] = [];

  let segStart = entries[0].timestamp;
  let segEnd = entries[0].timestamp;
  let segCount = 1;
  let segBytes = entries[0].messageSize;

  function closeSegment(complete: boolean) {
    segments.push({
      sessionId,
      sourceFile,
      firstMessageAt: segStart,
      lastMessageAt: segEnd,
      entryCount: segCount,
      complete,
    });
  }

  for (let i = 1; i < entries.length; i++) {
    const prev = new Date(entries[i - 1].timestamp).getTime();
    const curr = new Date(entries[i].timestamp).getTime();
    const gap = curr - prev;
    const nextBytes = segBytes + entries[i].messageSize;

    if (gap > gapMs || segCount >= MAX_ENTRIES_PER_SEGMENT || nextBytes > MAX_SEGMENT_BYTES) {
      // Split — close current segment, start new one
      // Segment is complete (hit a boundary, more entries follow)
      closeSegment(true);
      segStart = entries[i].timestamp;
      segEnd = entries[i].timestamp;
      segCount = 1;
      segBytes = entries[i].messageSize;
    } else {
      segEnd = entries[i].timestamp;
      segCount++;
      segBytes = nextBytes;
    }
  }

  // Close final segment — still active (may receive more entries)
  closeSegment(false);

  return segments;
}

/**
 * Rebuild conversation groupings for a source file.
 * Called after ingestion to update conversation boundaries.
 *
 * Uses database-level advisory locks to prevent concurrent rebuilds of the same file.
 * Scoped to file: only touches conversations for this file.
 * Archived conversations are left untouched.
 */
export function rebuildConversationsForFile(
  sourceFile: string,
  sessionId: string,
  gapMinutes: number,
): number {
  const db = getDb();

  // Try to acquire advisory lock for this source file
  const lockAcquired = db
    .query(
      `INSERT INTO memory_file_locks (source_file, operation, locked_by_pid, locked_at)
       VALUES (?, 'rebuilding', ?, datetime('now'))
       ON CONFLICT(source_file) DO NOTHING
       RETURNING source_file`,
    )
    .get(sourceFile, process.pid);

  if (!lockAcquired) {
    // Another process is already rebuilding this file
    throw new Error(
      `Cannot rebuild conversations for ${sourceFile}: already being rebuilt by another process`,
    );
  }

  try {
    // Get all entries for this file, ordered by timestamp (with size for chunking)
    const entries = db
      .query(
        `SELECT timestamp, length(content) as messageSize FROM memory_transcript_entries
        WHERE source_file = ?
        ORDER BY timestamp ASC, id ASC`,
      )
      .all(sourceFile) as Array<{ timestamp: string; messageSize: number }>;

    if (entries.length === 0) return 0;

    // Delete existing active/ready conversations for this file (re-import safe)
    deleteActiveConversationsForFile(sourceFile);

    // Segment by time gaps
    const segments = segmentByGaps(sessionId, sourceFile, entries, gapMinutes);

    // Upsert each segment as a conversation
    for (const seg of segments) {
      const convId = upsertConversation(seg);

      // Completed segments (hit entry/size limit, not the final active one)
      // are ready for processing — don't wait for the gap timeout
      if (seg.complete && convId) {
        updateConversationStatus(convId, "ready");
      }
    }

    // Mark conversations as ready if their gap has elapsed
    markConversationsReady(gapMinutes);

    return segments.length;
  } finally {
    // Release lock
    db.query(`DELETE FROM memory_file_locks WHERE source_file = ?`).run(sourceFile);
  }
}
