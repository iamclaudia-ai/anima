/**
 * Memory Extension — File Watcher
 *
 * Monitors a single base directory for JSONL file changes using chokidar.
 * On file add/change, incrementally ingests new content.
 *
 * Does NOT process existing files on startup — the extension start()
 * handles the initial scan before starting the watcher.
 */

import { watch, type FSWatcher } from "chokidar";
import { ingestFile } from "./ingest";

export interface WatcherConfig {
  /** Absolute path to the directory to watch */
  basePath: string;
  gapMinutes: number;
  exclude: string[];
}

export interface WatcherDiagnostics {
  ready: boolean;
  lastChangedAt: string | null;
  lastChangedFile: string | null;
  lastIngestAt: string | null;
  lastIngestFile: string | null;
  lastIngestEntries: number;
  lastErrorAt: string | null;
  lastError: string | null;
}

export class MemoryWatcher {
  private watcher: FSWatcher | null = null;
  private config: WatcherConfig;
  private log: (level: string, msg: string) => void;
  private ready = false;

  // Queue to serialize file processing
  private queue: string[] = [];
  private processing = false;
  private diagnostics: WatcherDiagnostics = {
    ready: false,
    lastChangedAt: null,
    lastChangedFile: null,
    lastIngestAt: null,
    lastIngestFile: null,
    lastIngestEntries: 0,
    lastErrorAt: null,
    lastError: null,
  };

  constructor(config: WatcherConfig, log: (level: string, msg: string) => void) {
    this.config = config;
    this.log = log;
  }

  start(): void {
    if (this.watcher) return;

    this.log("INFO", `Starting file watcher on: ${this.config.basePath}`);

    this.watcher = watch(this.config.basePath, {
      persistent: true,
      ignoreInitial: true, // Don't process existing files — startup scan handles that
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 200,
      },
      // Only ingest .jsonl files, but never ignore directories (including hidden dirs like ~/.claude).
      ignored: shouldIgnorePath,
    });

    this.watcher.on("ready", () => {
      this.ready = true;
      this.diagnostics.ready = true;
      this.log("INFO", "File watcher ready");
    });

    this.watcher.on("add", (path) => {
      if (!this.ready) return;
      this.log("INFO", `New file detected: ${path}`);
      this.recordChange(path);
      this.enqueue(path);
    });

    this.watcher.on("change", (path) => {
      this.log("INFO", `File changed: ${path}`);
      this.recordChange(path);
      this.enqueue(path);
    });

    this.watcher.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics.lastErrorAt = new Date().toISOString();
      this.diagnostics.lastError = message;
      this.log("ERROR", `Watcher error: ${message}`);
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.ready = false;
      this.diagnostics.ready = false;
    }
  }

  getDiagnostics(): WatcherDiagnostics {
    return { ...this.diagnostics };
  }

  private enqueue(filePath: string): void {
    if (!this.queue.includes(filePath)) {
      this.queue.push(filePath);
    }
    this.processQueue();
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const filePath = this.queue.shift();
      if (!filePath) continue;

      try {
        const result = ingestFile(filePath, this.config.basePath, this.config.gapMinutes, {
          exclude: this.config.exclude,
        });
        this.diagnostics.lastIngestAt = new Date().toISOString();
        this.diagnostics.lastIngestFile = filePath;
        this.diagnostics.lastIngestEntries = result.entriesInserted;
        if (result.entriesInserted > 0) {
          this.log("INFO", `Ingested ${result.entriesInserted} entries from ${filePath}`);
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            this.diagnostics.lastErrorAt = new Date().toISOString();
            this.diagnostics.lastError = err;
            this.log("ERROR", `Ingestion error: ${err}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.diagnostics.lastErrorAt = new Date().toISOString();
        this.diagnostics.lastError = message;
        this.log("ERROR", `Failed to process ${filePath}: ${message}`);
      }
    }

    this.processing = false;
  }

  private recordChange(filePath: string): void {
    this.diagnostics.lastChangedAt = new Date().toISOString();
    this.diagnostics.lastChangedFile = filePath;
  }
}

/**
 * Chokidar ignore predicate:
 * - never ignore directories (we need recursion to find nested JSONL files)
 * - ignore non-JSONL files only when we can confidently identify a regular file
 */
export function shouldIgnorePath(
  path: string,
  stats?: { isFile(): boolean; isDirectory(): boolean },
) {
  if (stats?.isDirectory()) return false;
  if (stats?.isFile()) return !path.endsWith(".jsonl");

  // If chokidar has not stat'ed the path yet, keep it to avoid
  // accidentally excluding hidden/directories with dots in their names.
  return false;
}
