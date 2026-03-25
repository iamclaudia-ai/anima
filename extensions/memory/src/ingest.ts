/**
 * Memory Extension — Ingestion Pipeline
 *
 * Core ingestion logic shared by startup scan, file watcher (real-time),
 * and the memory.ingest CLI command (manual import).
 *
 * File keys: All DB references use a relative "file key" — the path
 * relative to whichever root directory the file was imported from.
 * Since ~/.claude/projects-backup mirrors ~/.claude/projects, both
 * produce the same keys (e.g. "-Users-michael-Projects-foo/abc.jsonl").
 *
 * Two-phase ingestion:
 * 1. Mark file as "ingesting" with captured file_size (high water mark)
 * 2. Read, parse, insert entries, rebuild conversations
 * 3. Mark file as "idle" with updated offset and timestamp
 *
 * If we crash between 1 and 3, startup recovery detects the stuck
 * "ingesting" state and rolls back partial entries.
 */

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import {
  getDb,
  getFileState,
  markFileIngesting,
  markFileIdle,
  insertTranscriptEntriesRaw,
  deleteEntriesForFile,
  getStuckFiles,
  rollbackStuckFile,
  type InsertEntry,
} from "./db";
import { parseLines, sessionIdFromFilename } from "./parser";
import { rebuildConversationsForFile } from "./conversation";

export interface IngestResult {
  filesProcessed: number;
  entriesInserted: number;
  entriesDeleted: number;
  conversationsUpdated: number;
  errors: string[];
}

export interface IngestOptions {
  forceReimport?: boolean;
  exclude?: string[];
}

export interface CooperativeIngestOptions extends IngestOptions {
  yieldEvery?: number;
}

function emptyResult(): IngestResult {
  return {
    filesProcessed: 0,
    entriesInserted: 0,
    entriesDeleted: 0,
    conversationsUpdated: 0,
    errors: [],
  };
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Detect source type from file path.
 */
function detectSource(filePath: string): string {
  if (filePath.includes("pi-converted")) return "pi-converted";
  return "claude-code";
}

/**
 * Compute a relative file key from an absolute path and base directory.
 */
export function toFileKey(absolutePath: string, basePath: string): string {
  return relative(basePath, absolutePath);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function expandHome(path: string): string {
  return path.replace(/^~/, homedir());
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path.startsWith(withSlash);
}

/**
 * Determine whether a file should be excluded from ingestion.
 *
 * Exclusion pattern rules:
 * - Absolute patterns (`/` or `~`) match absolute watched file paths.
 * - Relative patterns match the computed file key (relative to watchPath).
 */
export function shouldExcludeFile(filePath: string, basePath: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false;

  const absPath = normalizePath(filePath);
  const fileKey = normalizePath(toFileKey(filePath, basePath));

  for (const rawPattern of exclude) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;

    const normalizedPattern = normalizePath(pattern);

    if (normalizedPattern.startsWith("/") || normalizedPattern.startsWith("~")) {
      const expanded = normalizePath(expandHome(normalizedPattern));
      if (pathMatchesPrefix(absPath, expanded)) return true;
      continue;
    }

    if (pathMatchesPrefix(fileKey, normalizedPattern)) return true;
  }

  return false;
}

/**
 * Recover from crashed ingestions.
 * Called on startup before the normal scan.
 *
 * For each file stuck in "ingesting" state:
 * 1. Delete partially-imported entries (for THIS file, after last committed timestamp)
 * 2. Rebuild conversations for the file
 * 3. Reset status to "idle"
 *
 * Returns number of files recovered.
 */
export function recoverStuckFiles(
  gapMinutes: number,
  log?: (level: string, msg: string) => void,
): number {
  const stuck = getStuckFiles();
  if (stuck.length === 0) return 0;

  for (const file of stuck) {
    log?.(
      "WARN",
      `Recovering stuck file: ${file.filePath} (last_entry_timestamp=${file.lastEntryTimestamp})`,
    );

    try {
      const deleted = rollbackStuckFile(
        file.filePath,
        file.lastCommittedEntryId,
        file.lastEntryTimestamp,
      );
      if (deleted > 0) {
        log?.("INFO", `Rolled back ${deleted} partial entries for ${file.filePath}`);
      }

      // Rebuild conversations from clean data
      const sessionId = sessionIdFromFilename(file.filePath);
      rebuildConversationsForFile(file.filePath, sessionId, gapMinutes);

      log?.("INFO", `Recovery complete for ${file.filePath}`);
    } catch (error) {
      log?.(
        "ERROR",
        `Recovery failed for ${file.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Don't rethrow — skip this file and continue with others
    }
  }

  return stuck.length;
}

/**
 * Ingest a single JSONL file.
 *
 * @param filePath - Absolute path to the file on disk (for reading)
 * @param basePath - Root directory to strip from filePath for the DB key
 * @param gapMinutes - Conversation gap threshold
 * @param options - forceReimport: delete existing entries and re-ingest
 */
export function ingestFile(
  filePath: string,
  basePath: string,
  gapMinutes: number,
  options: IngestOptions = {},
): IngestResult {
  const result = emptyResult();

  if (!existsSync(filePath)) {
    result.errors.push(`File not found: ${filePath}`);
    return result;
  }

  if (shouldExcludeFile(filePath, basePath, options.exclude || [])) {
    return result;
  }

  const fileKey = toFileKey(filePath, basePath);
  const stats = statSync(filePath);
  const source = detectSource(filePath);
  const existing = getFileState(fileKey);

  let offset = 0;
  let needsCleanup = false;

  if (existing) {
    if (options.forceReimport) {
      needsCleanup = true;
      offset = 0;
    } else if (stats.size <= existing.lastProcessedOffset) {
      if (stats.size < existing.lastProcessedOffset) {
        // File was truncated — treat as re-import
        needsCleanup = true;
        offset = 0;
      } else {
        // Same size, nothing to do
        return result;
      }
    } else {
      // Incremental: read from last offset
      offset = existing.lastProcessedOffset;
    }
  }

  // Phase 1: Mark as ingesting with captured file_size
  markFileIngesting({
    filePath: fileKey,
    source,
    lastModified: stats.mtimeMs,
    fileSize: stats.size,
  });

  // Read file content from offset to captured file_size
  const buffer = readFileSync(filePath);
  const content = buffer.toString("utf-8", offset, stats.size);

  // Parse JSONL lines and convert to insert entries
  const parsed = content.trim() ? parseLines(content, filePath) : [];
  const insertEntries: InsertEntry[] = parsed.map((e) => ({
    sessionId: e.sessionId,
    sourceFile: fileKey,
    role: e.role,
    content: e.content,
    toolNames: e.toolNames ? e.toolNames.join(", ") : null,
    timestamp: e.timestamp,
    cwd: e.cwd ?? null,
  }));

  const sessionId = sessionIdFromFilename(filePath);

  // Phase 2: Insert entries + rebuild conversations in a transaction
  const db = getDb();
  let committedEntryId: number | null = existing?.lastCommittedEntryId ?? null;
  let committedTimestamp: string | null = existing?.lastEntryTimestamp ?? null;

  const doInsert = db.transaction(() => {
    if (needsCleanup) {
      result.entriesDeleted = deleteEntriesForFile(fileKey);
    }

    if (insertEntries.length > 0) {
      insertTranscriptEntriesRaw(insertEntries);
    }

    if (needsCleanup || insertEntries.length > 0) {
      result.conversationsUpdated = rebuildConversationsForFile(fileKey, sessionId, gapMinutes);
    }

    const committed = db
      .query(
        `SELECT max(id) AS maxId, max(timestamp) AS maxTimestamp
         FROM memory_transcript_entries
         WHERE source_file = ?`,
      )
      .get(fileKey) as { maxId: number | null; maxTimestamp: string | null };
    committedEntryId = committed.maxId;
    committedTimestamp = committed.maxTimestamp;
  });

  doInsert();

  // Phase 3: Mark as idle with updated offset
  markFileIdle({
    filePath: fileKey,
    lastProcessedOffset: stats.size,
    lastCommittedEntryId: committedEntryId,
    lastEntryTimestamp: committedTimestamp,
  });

  result.filesProcessed = 1;
  result.entriesInserted = insertEntries.length;

  return result;
}

/**
 * Ingest all JSONL files in a directory (recursively).
 * The directory path is used as the base for computing relative file keys.
 */
export function ingestDirectory(
  dirPath: string,
  gapMinutes: number,
  options: IngestOptions = {},
): IngestResult {
  const result = emptyResult();

  if (!existsSync(dirPath)) {
    result.errors.push(`Directory not found: ${dirPath}`);
    return result;
  }

  const files = findJsonlFiles(dirPath);

  for (const file of files) {
    try {
      const fileResult = ingestFile(file, dirPath, gapMinutes, options);
      result.filesProcessed += fileResult.filesProcessed;
      result.entriesInserted += fileResult.entriesInserted;
      result.entriesDeleted += fileResult.entriesDeleted;
      result.conversationsUpdated += fileResult.conversationsUpdated;
      result.errors.push(...fileResult.errors);
    } catch (error) {
      result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

export async function ingestDirectoryCooperative(
  dirPath: string,
  gapMinutes: number,
  options: CooperativeIngestOptions = {},
): Promise<IngestResult> {
  const result = emptyResult();

  if (!existsSync(dirPath)) {
    result.errors.push(`Directory not found: ${dirPath}`);
    return result;
  }

  const yieldEvery = Math.max(1, options.yieldEvery ?? 10);
  const files = await findJsonlFilesCooperative(dirPath, yieldEvery);

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    try {
      const fileResult = ingestFile(file, dirPath, gapMinutes, options);
      result.filesProcessed += fileResult.filesProcessed;
      result.entriesInserted += fileResult.entriesInserted;
      result.entriesDeleted += fileResult.entriesDeleted;
      result.conversationsUpdated += fileResult.conversationsUpdated;
      result.errors.push(...fileResult.errors);
    } catch (error) {
      result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if ((index + 1) % yieldEvery === 0) {
      await yieldToEventLoop();
    }
  }

  return result;
}

/**
 * Recursively find all .jsonl files in a directory.
 */
function findJsonlFiles(dirPath: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function findJsonlFilesCooperative(dirPath: string, yieldEvery: number): Promise<string[]> {
  const files: string[] = [];
  const pendingDirs = [dirPath];
  let visitedDirs = 0;

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) continue;

    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(fullPath);
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }

    visitedDirs++;
    if (visitedDirs % yieldEvery === 0) {
      await yieldToEventLoop();
    }
  }

  return files;
}
