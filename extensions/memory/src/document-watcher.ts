/**
 * Memory Document Watcher
 *
 * Watches ~/memory for markdown file changes using chokidar.
 * Changes are coalesced so save storms do not continuously re-index the same file.
 */

import { watch, type FSWatcher } from "chokidar";

const DEFAULT_DEBOUNCE_MS = 1000;
const HOT_DEBOUNCE_MS = 2500;
const MAX_COALESCE_MS = 8000;
const HOT_FILE_THRESHOLD = 3;

export interface DocumentWatcherDiagnostics {
  ready: boolean;
  state: "idle" | "coalescing" | "indexing";
  queueDepth: number;
  hotFiles: number;
  hottestFile: string | null;
  lastChangedAt: string | null;
  lastChangedFile: string | null;
  lastIndexedAt: string | null;
  lastIndexedFile: string | null;
  filesIndexed: number;
  lastErrorAt: string | null;
  lastError: string | null;
  coalescedChanges: number;
}

export interface DocumentWatcherConfig {
  debounceMs?: number;
  hotDebounceMs?: number;
  maxCoalesceMs?: number;
}

interface PendingDocument {
  filePath: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  changeCount: number;
  nextEligibleAtMs: number;
}

interface DocumentWatcherDependencies {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upsertPendingDocument(
  existing: PendingDocument | undefined,
  filePath: string,
  atMs: number,
  config: Required<DocumentWatcherConfig>,
): PendingDocument {
  const firstSeenAtMs = existing?.firstSeenAtMs ?? atMs;
  const changeCount = (existing?.changeCount ?? 0) + 1;
  const debounceMs = changeCount >= HOT_FILE_THRESHOLD ? config.hotDebounceMs : config.debounceMs;

  return {
    filePath,
    firstSeenAtMs,
    lastSeenAtMs: atMs,
    changeCount,
    nextEligibleAtMs: Math.min(atMs + debounceMs, firstSeenAtMs + config.maxCoalesceMs),
  };
}

function selectReadyDocument(
  pending: Map<string, PendingDocument>,
  nowMs: number,
): PendingDocument | null {
  let selected: PendingDocument | null = null;
  for (const item of pending.values()) {
    if (item.nextEligibleAtMs > nowMs) continue;
    if (!selected || item.nextEligibleAtMs < selected.nextEligibleAtMs) {
      selected = item;
    }
  }
  return selected;
}

function nextDelayMs(pending: Map<string, PendingDocument>, nowMs: number): number | null {
  let nextAtMs: number | null = null;
  for (const item of pending.values()) {
    nextAtMs =
      nextAtMs === null ? item.nextEligibleAtMs : Math.min(nextAtMs, item.nextEligibleAtMs);
  }
  if (nextAtMs === null) return null;
  return Math.max(0, nextAtMs - nowMs);
}

export class DocumentWatcher {
  private watcher: FSWatcher | null = null;
  private ready = false;
  private processing = false;
  private stopped = false;
  private readonly pending = new Map<string, PendingDocument>();
  private readonly diagnostics: DocumentWatcherDiagnostics = {
    ready: false,
    state: "idle",
    queueDepth: 0,
    hotFiles: 0,
    hottestFile: null,
    lastChangedAt: null,
    lastChangedFile: null,
    lastIndexedAt: null,
    lastIndexedFile: null,
    filesIndexed: 0,
    lastErrorAt: null,
    lastError: null,
    coalescedChanges: 0,
  };
  private readonly deps: DocumentWatcherDependencies;
  private readonly config: Required<DocumentWatcherConfig>;

  constructor(
    private readonly memoryRoot: string,
    private readonly onFileChanged: (filePath: string) => void | Promise<void>,
    private readonly log: (level: string, msg: string) => void,
    config: DocumentWatcherConfig = {},
    deps: Partial<DocumentWatcherDependencies> = {},
  ) {
    this.config = {
      debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      hotDebounceMs: config.hotDebounceMs ?? HOT_DEBOUNCE_MS,
      maxCoalesceMs: config.maxCoalesceMs ?? MAX_COALESCE_MS,
    };
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? defaultSleep,
    };
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
      this.syncDiagnostics();
      this.log("INFO", "DocumentWatcher: Ready");
    });

    this.watcher.on("add", (path) => {
      if (!this.ready) return;
      this.log("INFO", `DocumentWatcher: New file detected: ${path}`);
      this.noteFileChanged(path);
    });

    this.watcher.on("change", (path) => {
      this.log("INFO", `DocumentWatcher: File changed: ${path}`);
      this.noteFileChanged(path);
    });

    this.watcher.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics.lastErrorAt = new Date().toISOString();
      this.diagnostics.lastError = message;
      this.log("ERROR", `DocumentWatcher error: ${message}`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.ready = false;
      this.diagnostics.ready = false;
      this.diagnostics.state = this.processing ? "indexing" : "idle";
    }
  }

  getDiagnostics(): DocumentWatcherDiagnostics {
    this.syncDiagnostics();
    return { ...this.diagnostics };
  }

  noteFileChanged(filePath: string, atMs = this.deps.now()): void {
    this.diagnostics.lastChangedAt = new Date(atMs).toISOString();
    this.diagnostics.lastChangedFile = filePath;
    this.pending.set(
      filePath,
      upsertPendingDocument(this.pending.get(filePath), filePath, atMs, this.config),
    );
    this.syncDiagnostics();
    void this.processLoop();
  }

  private async processLoop(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;

    try {
      while (!this.stopped && this.pending.size > 0) {
        const nowMs = this.deps.now();
        const ready = selectReadyDocument(this.pending, nowMs);
        if (!ready) {
          this.diagnostics.state = "coalescing";
          const delayMs = nextDelayMs(this.pending, nowMs);
          this.syncDiagnostics();
          if (delayMs === null) break;
          await this.deps.sleep(delayMs);
          continue;
        }

        this.pending.delete(ready.filePath);
        this.diagnostics.state = "indexing";
        this.syncDiagnostics();

        try {
          await this.onFileChanged(ready.filePath);
          this.diagnostics.filesIndexed += 1;
          this.diagnostics.lastIndexedAt = new Date(this.deps.now()).toISOString();
          this.diagnostics.lastIndexedFile = ready.filePath;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.diagnostics.lastErrorAt = new Date().toISOString();
          this.diagnostics.lastError = message;
          this.log("ERROR", `DocumentWatcher: Failed to process ${ready.filePath}: ${message}`);
        }

        if (this.pending.size > 0) {
          await this.deps.sleep(0);
        }
      }
    } finally {
      this.processing = false;
      this.diagnostics.state = this.pending.size > 0 ? "coalescing" : "idle";
      this.syncDiagnostics();
    }
  }

  private syncDiagnostics(): void {
    this.diagnostics.queueDepth = this.pending.size;
    this.diagnostics.hotFiles = 0;
    this.diagnostics.hottestFile = null;
    this.diagnostics.coalescedChanges = 0;

    let hottest: PendingDocument | null = null;
    for (const item of this.pending.values()) {
      if (item.changeCount >= HOT_FILE_THRESHOLD) {
        this.diagnostics.hotFiles += 1;
      }
      this.diagnostics.coalescedChanges += Math.max(0, item.changeCount - 1);
      if (!hottest || item.changeCount > hottest.changeCount) {
        hottest = item;
      }
    }
    this.diagnostics.hottestFile = hottest?.filePath ?? null;
  }
}
