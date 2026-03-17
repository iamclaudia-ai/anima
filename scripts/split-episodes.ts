#!/usr/bin/env bun
/**
 * Split Daily Episode Files → Per-Conversation Episode Files
 *
 * Migrates from:   ~/memory/episodes/2026-03/2026-03-17.md (multiple ## sections)
 * To:              ~/memory/episodes/2026-03/2026-03-17-0832-77841.md (one section per file)
 *
 * Matching strategy:
 *   1. Parse the ## time header + date from filename → approximate UTC timestamp
 *   2. Query memory_conversations for the closest match by (first_message_at, cwd)
 *   3. Use conversation ID in the filename
 *
 * Usage:
 *   bun scripts/split-episodes.ts [--dry-run] [--verbose]
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { Glob } from "bun";
import { homedir } from "node:os";

// ============================================================================
// Config
// ============================================================================

const MEMORY_ROOT = join(homedir(), "memory");
const EPISODES_DIR = join(MEMORY_ROOT, "episodes");
const DB_PATH = join(homedir(), ".claudia", "claudia.db");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const VERBOSE = args.has("--verbose");

// ============================================================================
// Database
// ============================================================================

interface ConversationRow {
  id: number;
  first_message_at: string;
  last_message_at: string;
  cwd: string | null;
  summary: string | null;
}

const db = new Database(DB_PATH, { readonly: true });
db.exec("PRAGMA busy_timeout = 3000");

/**
 * Load all archived conversations ordered by time.
 */
function loadConversations(): ConversationRow[] {
  return db
    .query(
      `SELECT id, first_message_at, last_message_at,
              json_extract(metadata, '$.cwd') as cwd,
              substr(summary, 1, 200) as summary
       FROM memory_conversations
       WHERE status IN ('archived', 'skipped')
       ORDER BY first_message_at`,
    )
    .all() as ConversationRow[];
}

// ============================================================================
// Episode Parsing
// ============================================================================

interface EpisodeChunk {
  /** Raw time header, e.g. "8:32 AM – 8:51 AM (EDT)" */
  timeHeader: string;
  /** Start hour:minute in 24h, e.g. "0832" */
  startTime24: string;
  /** Approximate UTC timestamp of start */
  startUtc: Date;
  /** Project path from **Project:** line, if any */
  project: string | null;
  /** Full content of this section (including the ## header) */
  content: string;
}

/**
 * Parse a daily episode file into individual conversation chunks.
 */
function parseEpisodeFile(filePath: string): EpisodeChunk[] {
  const content = readFileSync(filePath, "utf-8");
  const dateStr = basename(filePath, ".md"); // "2026-03-17"

  // Split on ## time headers
  const sections = content.split(
    /^(?=## \d{1,2}:\d{2}\s*(?:AM|PM)\s*[–—-]\s*\d{1,2}:\d{2}\s*(?:AM|PM))/im,
  );

  const chunks: EpisodeChunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Match the ## time header
    const headerMatch = trimmed.match(
      /^## (\d{1,2}):(\d{2})\s*(AM|PM)\s*[–—-]\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s*\((\w+)\)/im,
    );
    if (!headerMatch) {
      // This is likely the file title (e.g. "# March 2026") — skip
      if (VERBOSE) console.log(`  ⊘ Skipping non-episode section: ${trimmed.slice(0, 60)}...`);
      continue;
    }

    const [, hourStr, minStr, ampm, tz] = headerMatch;
    let hour = parseInt(hourStr);
    if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
    const min = parseInt(minStr);

    const startTime24 = `${hour.toString().padStart(2, "0")}${min.toString().padStart(2, "0")}`;

    // Build approximate UTC time from date + local time + timezone
    const startUtc = localToUtc(dateStr, hour, min, tz);

    // Extract **Project:** line
    const projectMatch = trimmed.match(/\*\*Project:\*\*\s*`?([^`\n]+)`?/);
    const project = projectMatch ? projectMatch[1].trim() : null;

    // Extract the full time header for display
    const timeHeaderMatch = trimmed.match(/^## (.+)$/m);
    const timeHeader = timeHeaderMatch ? timeHeaderMatch[1] : "unknown";

    chunks.push({
      timeHeader,
      startTime24,
      startUtc,
      project,
      content: trimmed,
    });
  }

  return chunks;
}

/**
 * Convert local time + timezone abbreviation to approximate UTC.
 * Handles EST/EDT/CST/CDT/PST/PDT. Defaults to EST (-5) for unknown.
 */
function localToUtc(dateStr: string, hour: number, min: number, tz: string): Date {
  const offsets: Record<string, number> = {
    EST: -5,
    EDT: -4,
    CST: -6,
    CDT: -5,
    PST: -8,
    PDT: -7,
    MST: -7,
    MDT: -6,
    Eastern: -5, // fallback
  };
  const offset = offsets[tz.toUpperCase()] ?? offsets[tz] ?? -5;

  // Create date in UTC by subtracting the offset
  const d = new Date(
    `${dateStr}T${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}:00.000Z`,
  );
  d.setUTCHours(d.getUTCHours() - offset);
  return d;
}

// ============================================================================
// Conversation Matching
// ============================================================================

/**
 * Find the best matching conversation for an episode chunk.
 * Strategy: find the conversation whose first_message_at is closest to the chunk's start time,
 * optionally weighted by matching cwd.
 *
 * Uses a "consumed" set to prevent multiple chunks from matching the same conversation.
 * Each conversation can only be used once.
 */
function findBestMatch(
  chunk: EpisodeChunk,
  conversations: ConversationRow[],
  consumed: Set<number>,
): { conv: ConversationRow; deltaMinutes: number } | null {
  const chunkTime = chunk.startUtc.getTime();

  // Build scored candidates, skipping already-consumed
  const candidates: { conv: ConversationRow; delta: number }[] = [];

  for (const conv of conversations) {
    if (consumed.has(conv.id)) continue;

    const convTime = new Date(conv.first_message_at).getTime();
    let delta = Math.abs(convTime - chunkTime);

    // Boost: if cwd matches project, reduce effective delta
    if (chunk.project && conv.cwd && conv.cwd === chunk.project) {
      delta *= 0.5; // Halve the delta for matching cwd
    }

    candidates.push({ conv, delta });
  }

  if (candidates.length === 0) return null;

  // Sort by delta ascending, pick best
  candidates.sort((a, b) => a.delta - b.delta);
  const best = candidates[0];

  const deltaMinutes = best.delta / 60_000;
  return { conv: best.conv, deltaMinutes };
}

// ============================================================================
// Main
// ============================================================================

function main() {
  console.log(
    `${DRY_RUN ? "🔍 DRY RUN — " : ""}Splitting daily episode files into per-conversation files\n`,
  );
  console.log(`Episodes dir: ${EPISODES_DIR}`);
  console.log(`Database: ${DB_PATH}\n`);

  const conversations = loadConversations();
  console.log(`Loaded ${conversations.length} conversations from DB\n`);

  // Find all daily episode files
  const glob = new Glob("**/*.md");
  const dailyFiles: string[] = [];

  for (const match of glob.scanSync({ cwd: EPISODES_DIR, absolute: false })) {
    // Only match daily files: YYYY-MM-DD.md (10 char basename)
    const name = basename(match, ".md");
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) {
      dailyFiles.push(match);
    }
  }

  dailyFiles.sort();
  console.log(`Found ${dailyFiles.length} daily episode files to split\n`);

  let totalChunks = 0;
  let totalWritten = 0;
  let totalSkipped = 0;
  let noMatchCount = 0;
  const consumed = new Set<number>(); // Track used conversation IDs globally
  const overwrites: string[] = [];

  for (const relPath of dailyFiles) {
    const fullPath = join(EPISODES_DIR, relPath);
    const dateStr = basename(relPath, ".md");
    const dir = dirname(relPath);

    const chunks = parseEpisodeFile(fullPath);
    if (chunks.length === 0) {
      if (VERBOSE) console.log(`  ⊘ ${relPath}: no parseable sections`);
      continue;
    }

    console.log(`📄 ${relPath} → ${chunks.length} conversation(s)`);

    for (const chunk of chunks) {
      totalChunks++;

      const match = findBestMatch(chunk, conversations, consumed);

      if (!match || match.deltaMinutes > 60) {
        // No match within 60 minutes — use timestamp only, no conv ID
        const filename = `${dateStr}-${chunk.startTime24}-unknown.md`;
        const outPath = join(EPISODES_DIR, dir, filename);
        const outRel = relative(EPISODES_DIR, outPath);

        if (match) {
          console.log(
            `  ⚠️  ${chunk.startTime24} → ${outRel} (closest conv #${match.conv.id} was ${match.deltaMinutes.toFixed(0)}min away)`,
          );
        } else {
          console.log(`  ⚠️  ${chunk.startTime24} → ${outRel} (no conversation match)`);
        }

        if (!DRY_RUN) {
          writeFileSync(outPath, chunk.content + "\n");
        }
        noMatchCount++;
        totalWritten++;
        continue;
      }

      const convId = match.conv.id;
      consumed.add(convId); // Mark as used so no other chunk gets this conv
      const filename = `${dateStr}-${chunk.startTime24}-${convId}.md`;
      const outPath = join(EPISODES_DIR, dir, filename);
      const outRel = relative(EPISODES_DIR, outPath);

      // Check if file already exists
      if (existsSync(outPath)) {
        overwrites.push(outRel);
        if (VERBOSE)
          console.log(
            `  ↻ ${chunk.startTime24} → ${outRel} (overwrite, conv #${convId}, Δ${match.deltaMinutes.toFixed(0)}min)`,
          );
      } else {
        if (VERBOSE)
          console.log(
            `  ✓ ${chunk.startTime24} → ${outRel} (conv #${convId}, Δ${match.deltaMinutes.toFixed(0)}min)`,
          );
      }

      if (!DRY_RUN) {
        const outDir = dirname(outPath);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        writeFileSync(outPath, chunk.content + "\n");
      }

      totalWritten++;
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total chunks parsed:  ${totalChunks}`);
  console.log(`Files written:        ${totalWritten}`);
  console.log(`No match (>60min):    ${noMatchCount}`);
  console.log(`Overwrites:           ${overwrites.length}`);

  if (overwrites.length > 0) {
    console.log(`\nOverwritten files:`);
    for (const f of overwrites) {
      console.log(`  - ${f}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\n🔍 DRY RUN — no files were written. Run without --dry-run to execute.`);
  } else {
    console.log(`\n✅ Done! Individual episode files written to ${EPISODES_DIR}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Review the output above for any ⚠️  warnings`);
    console.log(`  2. cd ~/memory && git add episodes/ && git diff --cached --stat`);
    console.log(`  3. Remove old daily files once satisfied`);
  }
}

main();
