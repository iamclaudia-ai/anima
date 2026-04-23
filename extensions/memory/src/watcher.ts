/**
 * Memory Extension — File Watcher
 *
 * Monitors a single base directory for JSONL file changes using fs.watch.
 * File churn is coalesced through an XState ingestion machine so hot transcript
 * files are processed eventually instead of on every write.
 */

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createActor, fromPromise, setup, assign } from "xstate";
import { ingestFile, yieldToEventLoop, type IngestResult } from "./ingest";

const DEFAULT_DEBOUNCE_MS = 2000;
const HOT_DEBOUNCE_MS = 5000;
const MAX_COALESCE_MS = 15000;
const MIN_REINGEST_INTERVAL_MS = 3000;
const ERROR_BACKOFF_MS = 2000;
const HOT_FILE_THRESHOLD = 3;

export interface WatcherConfig {
  /** Absolute path to the directory to watch */
  basePath: string;
  gapMinutes: number;
  exclude: string[];
  debounceMs?: number;
  hotDebounceMs?: number;
  maxCoalesceMs?: number;
  minReingestIntervalMs?: number;
  errorBackoffMs?: number;
}

export interface WatcherDiagnostics {
  ready: boolean;
  state: "idle" | "coalescing" | "ready" | "ingesting" | "backingOff";
  queueDepth: number;
  hotFiles: number;
  hottestFile: string | null;
  lastChangedAt: string | null;
  lastChangedFile: string | null;
  lastIngestAt: string | null;
  lastIngestFile: string | null;
  lastIngestEntries: number;
  lastErrorAt: string | null;
  lastError: string | null;
  currentFile: string | null;
  coalescedChanges: number;
}

interface PendingFileRecord {
  filePath: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  changeCount: number;
  nextEligibleAtMs: number;
  forceByAtMs: number;
  lastAttemptAtMs: number | null;
}

interface IngestionMachineContext {
  pending: Record<string, PendingFileRecord>;
  currentFile: string | null;
  lastCompletedAtByFile: Record<string, number>;
  lastError: string | null;
  lastErrorAt: string | null;
}

type IngestionMachineEvent =
  | { type: "FILE_CHANGED"; filePath: string; atMs?: number }
  | { type: "RECHECK" };

interface IngestionSleepResult {
  ready: boolean;
}

interface IngestNextOutput {
  filePath: string;
  result: IngestResult;
  completedAtIso: string;
  completedAtMs: number;
}

interface WatcherDependencies {
  ingestFile: typeof ingestFile;
  yieldToEventLoop: typeof yieldToEventLoop;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upsertPendingFile(
  record: PendingFileRecord | undefined,
  filePath: string,
  atMs: number,
  config: Required<
    Pick<WatcherConfig, "debounceMs" | "hotDebounceMs" | "maxCoalesceMs" | "minReingestIntervalMs">
  >,
  lastCompletedAtByFile: Record<string, number>,
): PendingFileRecord {
  const firstSeenAtMs = record?.firstSeenAtMs ?? atMs;
  const changeCount = (record?.changeCount ?? 0) + 1;
  const debounceMs = changeCount >= HOT_FILE_THRESHOLD ? config.hotDebounceMs : config.debounceMs;
  const earliestAtMs = atMs + debounceMs;
  const forceByAtMs = firstSeenAtMs + config.maxCoalesceMs;
  const lastCompletedAtMs = lastCompletedAtByFile[filePath] ?? 0;
  const minReingestAtMs =
    lastCompletedAtMs > 0 ? lastCompletedAtMs + config.minReingestIntervalMs : 0;

  return {
    filePath,
    firstSeenAtMs,
    lastSeenAtMs: atMs,
    changeCount,
    nextEligibleAtMs: Math.min(Math.max(earliestAtMs, minReingestAtMs), forceByAtMs),
    forceByAtMs,
    lastAttemptAtMs: record?.lastAttemptAtMs ?? null,
  };
}

function getPendingRecords(context: IngestionMachineContext): PendingFileRecord[] {
  return Object.values(context.pending);
}

function selectReadyFile(
  context: IngestionMachineContext,
  nowMs: number,
): PendingFileRecord | null {
  const ready = getPendingRecords(context)
    .filter((record) => record.nextEligibleAtMs <= nowMs)
    .sort((a, b) => a.nextEligibleAtMs - b.nextEligibleAtMs || a.firstSeenAtMs - b.firstSeenAtMs);
  return ready[0] ?? null;
}

function getNextEligibleDelayMs(context: IngestionMachineContext, nowMs: number): number | null {
  const pending = getPendingRecords(context);
  if (pending.length === 0) return null;
  const nextAtMs = Math.min(...pending.map((record) => record.nextEligibleAtMs));
  return Math.max(0, nextAtMs - nowMs);
}

function createIngestionMachine(
  config: Required<WatcherConfig>,
  deps: WatcherDependencies,
  diagnostics: WatcherDiagnostics,
  log: (level: string, msg: string) => void,
) {
  const machine = setup({
    types: {
      context: {} as IngestionMachineContext,
      events: {} as any,
    },
    actions: {
      noteFileChanged: assign({
        pending: ({ context, event }: any) => {
          const typedEvent = event as IngestionMachineEvent;
          if (typedEvent.type !== "FILE_CHANGED") return context.pending;
          const atMs = typedEvent.atMs ?? deps.now();
          const next = { ...context.pending };
          next[typedEvent.filePath] = upsertPendingFile(
            context.pending[typedEvent.filePath],
            typedEvent.filePath,
            atMs,
            config,
            context.lastCompletedAtByFile,
          );
          return next;
        },
      }),
      clearError: assign({
        lastError: null,
        lastErrorAt: null,
      }),
      syncDiagnostics: ({ context, self }: any) => {
        const pending = getPendingRecords(context);
        const hottest = pending
          .slice()
          .sort((a, b) => b.changeCount - a.changeCount || a.firstSeenAtMs - b.firstSeenAtMs)[0];
        diagnostics.state = String(self.getSnapshot().value) as WatcherDiagnostics["state"];
        diagnostics.queueDepth = pending.length;
        diagnostics.hotFiles = pending.filter(
          (record) => record.changeCount >= HOT_FILE_THRESHOLD,
        ).length;
        diagnostics.hottestFile = hottest?.filePath ?? null;
        diagnostics.currentFile = context.currentFile;
        diagnostics.lastError = context.lastError;
        diagnostics.lastErrorAt = context.lastErrorAt;
        diagnostics.coalescedChanges = pending.reduce(
          (sum, record) => sum + Math.max(0, record.changeCount - 1),
          0,
        );
      },
      startIngest: assign({
        currentFile: ({ context }: any) => {
          const selected = selectReadyFile(context, deps.now());
          return selected?.filePath ?? null;
        },
        pending: ({ context }: any) => {
          const selected = selectReadyFile(context, deps.now());
          if (!selected) return context.pending;
          const next = { ...context.pending };
          delete next[selected.filePath];
          return next;
        },
      }),
      publishFailureLog: ({ context, event }: any) => {
        const typedEvent = event as { error?: unknown };
        const message =
          typedEvent.error instanceof Error ? typedEvent.error.message : String(typedEvent.error);
        diagnostics.lastErrorAt = new Date().toISOString();
        diagnostics.lastError = message;
        log("ERROR", `Failed to process ${context.currentFile ?? "unknown file"}: ${message}`);
      },
      recordIngestSuccess: assign({
        currentFile: null,
        lastCompletedAtByFile: ({ context, event }: any) => {
          const typedEvent = event as { output?: IngestNextOutput };
          if (!typedEvent.output) {
            return context.lastCompletedAtByFile;
          }
          return {
            ...context.lastCompletedAtByFile,
            [typedEvent.output.filePath]: typedEvent.output.completedAtMs,
          };
        },
      }),
      recordIngestFailure: assign({
        currentFile: null,
        lastError: ({ event }: any) => {
          const typedEvent = event as { error?: unknown };
          return typedEvent.error instanceof Error
            ? typedEvent.error.message
            : String(typedEvent.error);
        },
        lastErrorAt: () => new Date().toISOString(),
      }),
      requeueFailedFile: assign({
        pending: ({ context }: any) => {
          if (!context.currentFile) return context.pending;
          const nowMs = deps.now();
          const retryAtMs = nowMs + config.errorBackoffMs;
          return {
            ...context.pending,
            [context.currentFile]: {
              filePath: context.currentFile,
              firstSeenAtMs: retryAtMs,
              lastSeenAtMs: retryAtMs,
              changeCount: HOT_FILE_THRESHOLD,
              nextEligibleAtMs: retryAtMs,
              forceByAtMs: retryAtMs + config.maxCoalesceMs,
              lastAttemptAtMs: nowMs,
            },
          };
        },
      }),
      publishSuccessDiagnostics: ({ event }: any) => {
        const typedEvent = event as { output?: IngestNextOutput };
        if (!typedEvent.output) return;
        diagnostics.lastIngestAt = typedEvent.output.completedAtIso;
        diagnostics.lastIngestFile = typedEvent.output.filePath;
        diagnostics.lastIngestEntries = typedEvent.output.result.entriesInserted;
        if (typedEvent.output.result.entriesInserted > 0) {
          log(
            "INFO",
            `Ingested ${typedEvent.output.result.entriesInserted} entries from ${typedEvent.output.filePath}`,
          );
        }
        if (typedEvent.output.result.errors.length > 0) {
          for (const err of typedEvent.output.result.errors) {
            diagnostics.lastErrorAt = typedEvent.output.completedAtIso;
            diagnostics.lastError = err;
            log("ERROR", `Ingestion error: ${err}`);
          }
        }
      },
    },
    guards: {
      hasPendingFiles: ({ context }: any) => getPendingRecords(context).length > 0,
      hasReadyFile: ({ context }: any) => selectReadyFile(context, deps.now()) !== null,
    },
    actors: {
      waitForNextReady: fromPromise<IngestionSleepResult, { context: IngestionMachineContext }>(
        async ({ input }) => {
          const { context } = input;
          const delayMs = getNextEligibleDelayMs(context, deps.now());
          if (delayMs === null) return { ready: false };
          if (delayMs > 0) {
            await deps.sleep(delayMs);
          }
          return { ready: true };
        },
      ),
      ingestNext: fromPromise<IngestNextOutput, { context: IngestionMachineContext }>(
        async ({ input }) => {
          const filePath = input.context.currentFile;
          if (!filePath) {
            throw new Error("No ready file available for ingestion");
          }

          const result = deps.ingestFile(filePath, config.basePath, config.gapMinutes, {
            exclude: config.exclude,
          });
          await deps.yieldToEventLoop();

          return {
            filePath,
            result,
            completedAtIso: new Date(deps.now()).toISOString(),
            completedAtMs: deps.now(),
          };
        },
      ),
      waitForBackoff: fromPromise(async () => {
        await deps.sleep(config.errorBackoffMs);
      }),
    },
  } as any).createMachine({
    id: "memoryWatcherIngestion",
    initial: "idle",
    context: () => ({
      pending: {},
      currentFile: null,
      lastCompletedAtByFile: {},
      lastError: null,
      lastErrorAt: null,
    }),
    states: {
      idle: {
        entry: "syncDiagnostics",
        on: {
          FILE_CHANGED: {
            target: "coalescing",
            actions: ["noteFileChanged", "clearError"],
          },
          RECHECK: {
            actions: "syncDiagnostics",
          },
        },
      },
      coalescing: {
        entry: "syncDiagnostics",
        invoke: {
          src: "waitForNextReady",
          input: ({ context }: any) => ({ context }),
          onDone: {
            target: "ready",
          },
        },
        on: {
          FILE_CHANGED: {
            target: "coalescing",
            reenter: true,
            actions: ["noteFileChanged", "clearError"],
          },
          RECHECK: {
            actions: "syncDiagnostics",
          },
        },
      },
      ready: {
        entry: "syncDiagnostics",
        always: [
          { guard: "hasReadyFile", target: "ingesting", actions: "startIngest" },
          { guard: "hasPendingFiles", target: "coalescing" },
          { target: "idle" },
        ],
        on: {
          FILE_CHANGED: {
            target: "coalescing",
            actions: ["noteFileChanged", "clearError"],
          },
        },
      },
      ingesting: {
        entry: "syncDiagnostics",
        invoke: {
          src: "ingestNext",
          input: ({ context }: any) => ({ context }),
          onDone: {
            target: "ready",
            actions: ["recordIngestSuccess", "publishSuccessDiagnostics"],
          },
          onError: {
            target: "backingOff",
            actions: ["publishFailureLog", "recordIngestFailure", "requeueFailedFile"],
          },
        },
        on: {
          FILE_CHANGED: {
            actions: ["noteFileChanged", "clearError", "syncDiagnostics"],
          },
        },
      },
      backingOff: {
        entry: "syncDiagnostics",
        invoke: {
          src: "waitForBackoff",
          onDone: {
            target: "ready",
          },
        },
        on: {
          FILE_CHANGED: {
            target: "coalescing",
            actions: ["noteFileChanged", "clearError"],
          },
        },
      },
    },
  } as any);
  return machine as any;
}

export class MemoryWatcher {
  private watcher: FSWatcher | null = null;
  private config: Required<WatcherConfig>;
  private log: (level: string, msg: string) => void;
  private ready = false;
  private deps: WatcherDependencies;
  private actor: { start(): void; stop(): void; send(event: IngestionMachineEvent): void };
  private diagnostics: WatcherDiagnostics = {
    ready: false,
    state: "idle",
    queueDepth: 0,
    hotFiles: 0,
    hottestFile: null,
    lastChangedAt: null,
    lastChangedFile: null,
    lastIngestAt: null,
    lastIngestFile: null,
    lastIngestEntries: 0,
    lastErrorAt: null,
    lastError: null,
    currentFile: null,
    coalescedChanges: 0,
  };

  constructor(
    config: WatcherConfig,
    log: (level: string, msg: string) => void,
    deps: Partial<WatcherDependencies> = {},
  ) {
    this.config = {
      ...config,
      debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      hotDebounceMs: config.hotDebounceMs ?? HOT_DEBOUNCE_MS,
      maxCoalesceMs: config.maxCoalesceMs ?? MAX_COALESCE_MS,
      minReingestIntervalMs: config.minReingestIntervalMs ?? MIN_REINGEST_INTERVAL_MS,
      errorBackoffMs: config.errorBackoffMs ?? ERROR_BACKOFF_MS,
    };
    this.log = log;
    this.deps = {
      ingestFile: deps.ingestFile ?? ingestFile,
      yieldToEventLoop: deps.yieldToEventLoop ?? yieldToEventLoop,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? defaultSleep,
    };
    this.actor = createActor(
      createIngestionMachine(this.config, this.deps, this.diagnostics, this.log),
    );
    this.actor.start();
  }

  start(): void {
    if (this.watcher) return;

    this.log("INFO", `Starting file watcher on: ${this.config.basePath}`);

    this.watcher = watch(
      this.config.basePath,
      {
        persistent: true,
        recursive: true,
      },
      (eventType, relativePath) => {
        if (!relativePath) return;

        const filePath = join(this.config.basePath, String(relativePath));
        const stats = safeStat(filePath);
        if (shouldIgnorePath(filePath, stats)) return;
        if (stats?.isDirectory()) return;

        if (eventType === "rename") {
          if (!existsSync(filePath)) return;
          if (!this.ready) return;
          this.log("INFO", `New file detected: ${filePath}`);
          this.noteFileChanged(filePath);
          return;
        }

        this.log("INFO", `File changed: ${filePath}`);
        this.noteFileChanged(filePath);
      },
    );

    this.watcher.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics.lastErrorAt = new Date().toISOString();
      this.diagnostics.lastError = message;
      this.log("ERROR", `Watcher error: ${message}`);
    });

    this.ready = true;
    this.diagnostics.ready = true;
    this.log("INFO", "File watcher ready");
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.ready = false;
      this.diagnostics.ready = false;
    }
    this.actor.stop();
  }

  getDiagnostics(): WatcherDiagnostics {
    this.actor.send({ type: "RECHECK" });
    return { ...this.diagnostics };
  }

  noteFileChanged(filePath: string, atMs?: number): void {
    this.diagnostics.lastChangedAt = new Date(this.deps.now()).toISOString();
    this.diagnostics.lastChangedFile = filePath;
    this.actor.send({ type: "FILE_CHANGED", filePath, atMs });
  }
}

/**
 * Ignore predicate:
 * - never ignore directories (we need recursion to find nested JSONL files)
 * - ignore non-JSONL files only when we can confidently identify a regular file
 */
export function shouldIgnorePath(
  path: string,
  stats?: { isFile(): boolean; isDirectory(): boolean },
) {
  if (stats?.isDirectory()) return false;
  if (stats?.isFile()) return !path.endsWith(".jsonl");

  return false;
}

function safeStat(path: string): { isFile(): boolean; isDirectory(): boolean } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
