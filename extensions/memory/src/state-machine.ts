/**
 * Memory Extension State Machine (XState)
 *
 * Manages the extension lifecycle with automatic crash recovery and state persistence.
 * State is persisted to SQLite on every transition, allowing recovery after crashes.
 *
 * States:
 * - stopped: Extension is not running
 * - recovering: Performing crash recovery (rollback stuck files, reset conversations)
 * - scanning: Running startup scan of watchPath
 * - startingWatcher: Initializing file watcher
 * - running: Fully operational, watching files and processing
 * - stopping: Shutting down cleanly
 *
 * The gateway heartbeat (every 60s) only updates liveness state.
 * Scheduler/business progression runs outside the state machine.
 */

import { setup, assign, fromPromise } from "xstate";
import type { ExtensionContext } from "@anima/shared";
import { existsSync } from "node:fs";
import { getDb } from "./db";
import { recoverStuckFiles, ingestDirectoryCooperative, type IngestResult } from "./ingest";
import { MemoryWatcher } from "./watcher";
import type { MemoryConfig } from "./index";

// ============================================================================
// Context & Events
// ============================================================================

interface MemoryExtensionContext {
  processId: number;
  startedAt: string | null;
  lastHeartbeat: string | null;
  config: Required<MemoryConfig>;
  basePath: string;
  watcher: MemoryWatcher | null;
  ctx: ExtensionContext | null;
  fileLog: (level: string, msg: string) => void;
}

type MemoryExtensionEvent =
  | { type: "START" }
  | { type: "RECOVERY_COMPLETE"; recovered: number }
  | { type: "RECOVERY_FAILED"; error: string }
  | { type: "SCAN_COMPLETE"; result: IngestResult }
  | { type: "SCAN_FAILED"; error: string }
  | { type: "WATCHER_READY" }
  | { type: "WATCHER_FAILED"; error: string }
  | { type: "HEARTBEAT" }
  | { type: "FILE_CHANGED"; filePath: string }
  | { type: "STOP" }
  | { type: "CLEANUP_COMPLETE" };

// ============================================================================
// State Machine Definition
// ============================================================================

export const memoryExtensionMachine = setup({
  types: {
    context: {} as MemoryExtensionContext,
    events: {} as MemoryExtensionEvent,
    input: {} as MemoryExtensionContext,
  },
  guards: {
    noRecentRunningInstance: () => true,
  },
  actions: {
    recordStartTime: assign({
      startedAt: () => new Date().toISOString(),
    }),
    updateHeartbeat: assign({
      lastHeartbeat: () => new Date().toISOString(),
    }),
    clearState: assign({
      startedAt: null,
      lastHeartbeat: null,
      watcher: null,
      ctx: null,
    }),
    logStateTransition: ({ context, event }) => {
      context.fileLog("INFO", `[StateMachine] Event: ${event.type}`);
    },
  },
  actors: {
    performCrashRecovery: fromPromise<number, { context: MemoryExtensionContext }>(
      async ({ input }) => {
        const { context } = input;
        let totalRecovered = 0;

        // Step 1: Rollback stuck files
        const recovered = recoverStuckFiles(context.config.conversationGapMinutes, context.fileLog);
        if (recovered > 0) {
          context.fileLog("INFO", `Crash recovery: rolled back ${recovered} stuck file(s)`);
          totalRecovered += recovered;
        }

        // Step 2: Leave in-flight Libby conversations alone.
        // The worker reconciles processing rows against the session layer and
        // either recovers the response or requeues the work once recovery fails.

        // Step 3: Clean up stale file locks (older than 5 min)
        const result = getDb()
          .query(
            `DELETE FROM memory_file_locks
             WHERE datetime(locked_at, '+5 minutes') < datetime('now')`,
          )
          .run();

        if (result.changes > 0) {
          context.fileLog("INFO", `Cleaned up ${result.changes} stale file locks`);
          totalRecovered += result.changes;
        }

        return totalRecovered;
      },
    ),
    performStartupScan: fromPromise<IngestResult, { context: MemoryExtensionContext }>(
      async ({ input }) => {
        const { context } = input;

        if (!existsSync(context.basePath)) {
          return {
            filesProcessed: 0,
            entriesInserted: 0,
            entriesDeleted: 0,
            conversationsUpdated: 0,
            errors: [],
          };
        }

        context.fileLog("INFO", `Startup scan: ${context.basePath}`);
        const scanResult = await ingestDirectoryCooperative(
          context.basePath,
          context.config.conversationGapMinutes,
          {
            exclude: context.config.exclude,
            yieldEvery: 10,
          },
        );

        if (scanResult.filesProcessed > 0 || scanResult.entriesInserted > 0) {
          context.fileLog(
            "INFO",
            `Startup scan complete: ${scanResult.filesProcessed} files, ${scanResult.entriesInserted} new entries`,
          );
        } else {
          context.fileLog("INFO", "Startup scan complete: no changes");
        }

        if (scanResult.errors.length > 0) {
          for (const err of scanResult.errors) {
            context.fileLog("ERROR", `Startup scan error: ${err}`);
          }
        }

        return scanResult;
      },
    ),
    initializeWatcher: fromPromise<void, { context: MemoryExtensionContext }>(async ({ input }) => {
      const { context } = input;

      if (!context.config.watch) {
        // Watch disabled, skip to running
        context.fileLog("INFO", "File watching disabled (watch: false)");
        return;
      }

      const watcher = new MemoryWatcher(
        {
          basePath: context.basePath,
          gapMinutes: context.config.conversationGapMinutes,
          exclude: context.config.exclude,
        },
        context.fileLog,
      );

      watcher.start();
      context.watcher = watcher;
      context.ctx?.log.info(`File watcher started on ${context.basePath}`);

      // Close the scan→watcher gap: run one incremental catch-up pass after
      // watcher startup so writes that landed between startup scan completion
      // and watcher readiness are picked up.
      const catchUpResult = await ingestDirectoryCooperative(
        context.basePath,
        context.config.conversationGapMinutes,
        { exclude: context.config.exclude, yieldEvery: 10 },
      );
      if (catchUpResult.entriesInserted > 0 || catchUpResult.filesProcessed > 0) {
        context.fileLog(
          "INFO",
          `Watcher catch-up complete: ${catchUpResult.filesProcessed} files, ${catchUpResult.entriesInserted} new entries`,
        );
      }
      if (catchUpResult.errors.length > 0) {
        for (const err of catchUpResult.errors) {
          context.fileLog("ERROR", `Watcher catch-up error: ${err}`);
        }
      }
    }),
  },
}).createMachine({
  id: "memoryExtension",
  initial: "stopped",
  context: ({ input }) => input,
  states: {
    stopped: {
      on: {
        START: {
          target: "recovering",
          guard: "noRecentRunningInstance",
          actions: ["recordStartTime", "logStateTransition"],
        },
      },
    },
    recovering: {
      entry: "logStateTransition",
      invoke: {
        src: "performCrashRecovery",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "scanning",
          actions: assign({
            // Recovery complete, log the count
            startedAt: ({ context, event }) => {
              if (event.output > 0) {
                context.fileLog("INFO", `Crash recovery complete: ${event.output} items recovered`);
              }
              return context.startedAt;
            },
          }),
        },
        onError: {
          target: "stopped",
          actions: ({ context, event }) => {
            context.fileLog("ERROR", `Crash recovery failed: ${event.error}`);
          },
        },
      },
    },
    scanning: {
      entry: "logStateTransition",
      invoke: {
        src: "performStartupScan",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "startingWatcher",
        },
        onError: {
          target: "stopped",
          actions: ({ context, event }) => {
            context.fileLog("ERROR", `Startup scan failed: ${event.error}`);
          },
        },
      },
    },
    startingWatcher: {
      entry: "logStateTransition",
      invoke: {
        src: "initializeWatcher",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "running",
        },
        onError: {
          target: "stopped",
          actions: ({ context, event }) => {
            context.fileLog("ERROR", `Watcher initialization failed: ${event.error}`);
          },
        },
      },
    },
    running: {
      entry: [
        "logStateTransition",
        ({ context }) => {
          context.ctx?.log.info("Memory extension started");
          context.fileLog("INFO", "[memory] Memory extension started");
        },
      ],
      on: {
        HEARTBEAT: {
          target: "running",
          actions: ["updateHeartbeat"],
        },
        STOP: {
          target: "stopping",
          actions: "logStateTransition",
        },
      },
    },
    stopping: {
      entry: [
        "logStateTransition",
        async ({ context }) => {
          context.ctx?.log.info("Stopping memory extension...");

          // Stop watcher
          if (context.watcher) {
            await context.watcher.stop();
            context.watcher = null;
          }

          context.fileLog("INFO", "[memory] Memory extension stopped");
        },
      ],
      always: {
        target: "stopped",
        actions: "clearState",
      },
    },
  },
});
