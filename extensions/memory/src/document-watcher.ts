/**
 * Memory Document Watcher
 *
 * Watches ~/memory for markdown file changes using chokidar.
 * When a .md file is created or modified, triggers ingestion
 * into memory_documents (FTS is updated via SQL triggers).
 *
 * Same pattern as MemoryWatcher but for markdown files
 * instead of JSONL session files.
 */

import { watch, type FSWatcher } from "chokidar";

export interface DocumentWatcherDiagnostics {
  ready: boolean;
  lastChangedAt: string | null;
  lastChangedFile: string | null;
  filesIndexed: number;
}

export class DocumentWatcher {
  private watcher: FSWatcher | null = null;
  private ready = false;
  private diagnostics: DocumentWatcherDiagnostics = {
    ready: false,
    lastChangedAt: null,
    lastChangedFile: null,
    filesIndexed: 0,
  };

  private log: (level: string, msg: string) => void;
  private onFileChanged: (filePath: string) => void;
  private memoryRoot: string;

  constructor(
    memoryRoot: string,
    onFileChanged: (filePath: string) => void,
    log: (level: string, msg: string) => void,
  ) {
    this.memoryRoot = memoryRoot;
    this.onFileChanged = onFileChanged;
    this.log = log;
  }

  start(): void {
    if (this.watcher) return;

    this.log("INFO", `DocumentWatcher: Starting on ${this.memoryRoot}`);

    this.watcher = watch(this.memoryRoot, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
      ignored: [
        "**/libby/**",
        "**/.git/**",
        "**/node_modules/**",
        // Only watch .md files
        (path: string, stats?: { isFile(): boolean; isDirectory(): boolean }) => {
          if (stats?.isDirectory()) return false;
          if (stats?.isFile()) return !path.endsWith(".md");
          return false;
        },
      ],
    });

    this.watcher.on("ready", () => {
      this.ready = true;
      this.diagnostics.ready = true;
      this.log("INFO", "DocumentWatcher: Ready");
    });

    this.watcher.on("add", (path) => {
      if (!this.ready) return;
      this.handleChange(path);
    });

    this.watcher.on("change", (path) => {
      this.handleChange(path);
    });

    this.watcher.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log("ERROR", `DocumentWatcher error: ${message}`);
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

  getDiagnostics(): DocumentWatcherDiagnostics {
    return { ...this.diagnostics };
  }

  private handleChange(filePath: string): void {
    this.diagnostics.lastChangedAt = new Date().toISOString();
    this.diagnostics.lastChangedFile = filePath;

    try {
      this.onFileChanged(filePath);
      this.diagnostics.filesIndexed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log("ERROR", `DocumentWatcher: Failed to process ${filePath}: ${msg}`);
    }
  }
}
