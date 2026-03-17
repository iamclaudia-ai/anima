/**
 * Memory Document Ingestion
 *
 * Ingests ~/memory markdown files into the memory_documents table.
 * SQL triggers automatically sync changes to the FTS5 index.
 *
 * Category is extracted from the first directory segment of the file path
 * relative to ~/memory (e.g., episodes, milestones, relationships).
 */

import { readFileSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { Glob } from "bun";
import { upsertMemoryDocument, deleteMemoryDocument, getMemoryDocumentMtime } from "./db";

// ============================================================================
// Category Extraction
// ============================================================================

/** Known memory categories from the ~/memory directory structure */
const KNOWN_CATEGORIES = new Set([
  "episodes",
  "milestones",
  "insights",
  "relationships",
  "projects",
  "core",
  "personas",
  "docs",
]);

/**
 * Extract the memory category from a file path relative to memoryRoot.
 *
 * ~/memory/episodes/2026-03/2026-03-09.md → "episodes"
 * ~/memory/relationships/michael/overview.md → "relationships"
 * ~/memory/libby-questions.md → "other"
 */
export function getCategoryFromPath(filePath: string, memoryRoot: string): string {
  const rel = relative(memoryRoot, filePath);
  const firstSegment = rel.split("/")[0];

  if (KNOWN_CATEGORIES.has(firstSegment)) {
    return firstSegment;
  }

  return "other";
}

// ============================================================================
// Title Extraction
// ============================================================================

/**
 * Extract the title from a markdown file.
 * Uses the first `# heading` if present, otherwise the filename without extension.
 */
function extractTitle(content: string, filePath: string): string {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }
  return basename(filePath, extname(filePath));
}

// ============================================================================
// Ingestion
// ============================================================================

/**
 * Ingest a single markdown file into memory_documents.
 * The SQL trigger on memory_documents handles FTS indexing automatically.
 *
 * Compares file mtime against stored mtime to skip unchanged files.
 * Pass `force: true` to bypass the mtime check (used by DocumentWatcher
 * which already knows the file changed).
 */
export function ingestMemoryDocument(
  filePath: string,
  memoryRoot: string,
  log?: (level: string, msg: string) => void,
  opts?: { force?: boolean },
): boolean {
  try {
    const stat = statSync(filePath);
    const fileMtime = stat.mtime.toISOString();

    // Skip if file hasn't changed since last ingestion
    if (!opts?.force) {
      const storedMtime = getMemoryDocumentMtime(filePath);
      if (storedMtime === fileMtime) return false;
    }

    const content = readFileSync(filePath, "utf-8");
    if (!content.trim()) return false;

    const category = getCategoryFromPath(filePath, memoryRoot);
    const title = extractTitle(content, filePath);

    upsertMemoryDocument({
      filePath,
      category,
      title,
      content,
      fileModifiedAt: fileMtime,
    });

    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log?.("ERROR", `Failed to ingest document ${filePath}: ${msg}`);
    return false;
  }
}

/**
 * Remove a document from the index (e.g., when file is deleted).
 */
export function removeMemoryDocument(filePath: string): void {
  deleteMemoryDocument(filePath);
}

// ============================================================================
// Directory Scanning
// ============================================================================

/** Directories to skip during scanning */
const IGNORED_DIRS = new Set(["libby", ".git", "node_modules"]);

/**
 * Scan ~/memory recursively and ingest all .md files.
 * Skips libby/, .git/, node_modules/, and dotfiles.
 *
 * Returns the count of documents ingested.
 */
export function scanAndIngestMemoryDir(
  memoryRoot: string,
  log?: (level: string, msg: string) => void,
): number {
  let count = 0;

  const glob = new Glob("**/*.md");
  for (const match of glob.scanSync({ cwd: memoryRoot, absolute: false })) {
    // Skip ignored directories
    const firstSegment = match.split("/")[0];
    if (IGNORED_DIRS.has(firstSegment)) continue;

    // Skip dotfiles
    if (match.startsWith(".") || match.includes("/.")) continue;

    const fullPath = join(memoryRoot, match);
    if (ingestMemoryDocument(fullPath, memoryRoot, log)) {
      count++;
    }
  }

  return count;
}
