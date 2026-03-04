/**
 * Claudia Memory Extension
 *
 * Ingests session transcripts from JSONL log files into SQLite,
 * groups them into conversations by detecting time gaps, and
 * provides the foundation for Libby (the Librarian) to process
 * completed conversations into durable memories.
 *
 * Startup flow:
 * 1. Connect to DB
 * 2. Scan all JSONL files in watchPath — incremental import (skip unchanged, import new/grown files)
 * 3. Start chokidar watcher for real-time changes
 * 4. Register gateway.heartbeat handler for marking conversations as ready
 *
 * All files are keyed relative to watchPath, so importing from
 * ~/.claude/projects-backup and watching ~/.claude/projects produce
 * the same keys — no double imports.
 */

import type {
  ClaudiaExtension,
  ExtensionContext,
  HealthCheckResponse,
  HealthItem,
} from "@claudia/shared";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { createActor, type ActorRefFrom, type SnapshotFrom } from "xstate";
import {
  getDb,
  closeDb,
  getStats,
  getReadyConversations,
  getEntriesForConversation,
  markConversationsReady,
  getProcessingConversations,
  resetConversationToQueued,
  updateConversationStatus,
  queueConversations,
  getQueuedCount,
  getActiveWorkItems,
  acquireMemoryExtensionLock,
  renewMemoryExtensionLock,
  releaseMemoryExtensionLock,
  getMemoryExtensionLockStatus,
} from "./db";
import { ingestFile, ingestDirectory, recoverStuckFiles } from "./ingest";
import { MemoryWatcher } from "./watcher";
import { formatTranscript } from "./transcript-formatter";
import { LibbyWorker, type LibbyConfig } from "./libby";
import { memoryExtensionMachine } from "./state-machine";

// ============================================================================
// File Logging (tail -f ~/.claudia/logs/memory.log)
// ============================================================================

const LOG_DIR = join(homedir(), ".claudia", "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "memory.log");

function fileLog(level: string, msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [${level}] ${msg}\n`);
  } catch {
    // Ignore log write errors
  }
}

// ============================================================================
// Configuration
// ============================================================================

export interface MemoryConfig {
  /** Base directory to watch for JSONL sessions (default: ~/.claude/projects) */
  watchPath?: string;
  /** Enable file watching + startup scan (default: true) */
  watch?: boolean;
  /** Minutes of silence before a conversation is considered "done" (default: 60) */
  conversationGapMinutes?: number;
  /** Minimum messages in a conversation for Libby to process it (default: 5) */
  minConversationMessages?: number;
  /** Timezone for Libby's transcript formatting (default: America/New_York) */
  timezone?: string;
  /** Model for Libby to use via session.send_prompt (default: claude-sonnet-4-6) */
  model?: string;
  /** Max conversations per memory.process invocation (default: 10) */
  processBatchSize?: number;
  /** Auto-process ready conversations on poll timer (default: false) */
  autoProcess?: boolean;
}

const DEFAULT_CONFIG: Required<MemoryConfig> = {
  watchPath: "~/.claude/projects",
  watch: true,
  conversationGapMinutes: 60,
  minConversationMessages: 5,
  timezone: "America/New_York",
  model: "claude-sonnet-4-6",
  processBatchSize: 10,
  autoProcess: false,
};

const LOCK_STALE_MS = 3 * 60 * 1000;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Wait for an XState actor to reach a specific state
 */
function waitForState(
  actor: ActorRefFrom<typeof memoryExtensionMachine>,
  targetState: "stopped" | "recovering" | "scanning" | "startingWatcher" | "running" | "stopping",
  timeoutMs = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already in target state
    if (actor.getSnapshot().value === targetState) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error(`Timeout waiting for state: ${targetState}`));
    }, timeoutMs);

    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.value === targetState) {
        clearTimeout(timeout);
        subscription.unsubscribe();
        resolve();
      }
    });
  });
}

function toPersistableSnapshot(snapshot: SnapshotFrom<typeof memoryExtensionMachine>) {
  return {
    value: snapshot.value,
    status: snapshot.status,
    context: {
      processId: snapshot.context.processId,
      startedAt: snapshot.context.startedAt,
      lastHeartbeat: snapshot.context.lastHeartbeat,
      basePath: snapshot.context.basePath,
      config: snapshot.context.config,
    },
  };
}

function formatElapsedSince(iso: string | null): string {
  if (!iso) return "n/a";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "n/a";
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  return `${Math.round(diffMs / 3_600_000)}h ago`;
}

function compactHomePath(path: string | null): string {
  if (!path) return "n/a";
  return path.replace(/^\/Users\/\w+/, "~");
}

// ============================================================================
// Memory Extension
// ============================================================================

export function createMemoryExtension(config: MemoryConfig = {}): ClaudiaExtension {
  const defined = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  const cfg: Required<MemoryConfig> = { ...DEFAULT_CONFIG, ...defined };

  // Expand ~ once
  const expandPath = (p: string) => p.replace(/^~/, homedir());
  const basePath = expandPath(cfg.watchPath);

  let ctx: ExtensionContext | null = null;
  let watcher: MemoryWatcher | null = null;
  let worker: LibbyWorker | null = null;
  let extensionActor: ActorRefFrom<typeof memoryExtensionMachine> | null = null;
  let isLockOwner = false;
  let lockState: "held" | "contended" | "released" = "released";
  let unsubscribeHeartbeat: (() => void) | null = null;

  return {
    id: "memory",
    name: "Memory (Ingestion + Libby)",
    methods: [
      {
        name: "memory.health_check",
        description: "Return memory system stats: file count, entry count, conversation breakdown",
        inputSchema: z.object({}),
      },
      {
        name: "memory.ingest",
        description:
          "Manually ingest JSONL file(s) into the memory database. Paths are relative to the watch directory unless absolute.",
        inputSchema: z.object({
          file: z.string().optional().describe("Path to a single JSONL file to ingest"),
          dir: z
            .string()
            .optional()
            .describe("Path to a directory of JSONL files to ingest recursively"),
          reimport: z
            .boolean()
            .optional()
            .describe("Force re-import: delete existing entries and re-ingest"),
        }),
      },
      {
        name: "memory.conversations",
        description: "List conversations with optional status filter",
        inputSchema: z.object({
          status: z
            .enum(["active", "ready", "queued", "processing", "archived", "skipped", "review"])
            .optional()
            .describe("Filter by conversation status"),
          limit: z.number().optional().describe("Max conversations to return (default: 50)"),
        }),
      },
      {
        name: "memory.process",
        description:
          "Queue ready conversations for Libby to process into structured memories in ~/memory/. Worker processes them one at a time in the background.",
        inputSchema: z.object({
          batchSize: z
            .number()
            .optional()
            .describe("Max conversations to queue (default: from config)"),
        }),
      },
      {
        name: "memory.process_conversation",
        description:
          "Process a specific conversation by ID through Libby. Temporarily marks it as ready if needed.",
        inputSchema: z.object({
          id: z.number().describe("Conversation ID to process"),
          dryRun: z
            .boolean()
            .optional()
            .describe("Format transcript only, don't call API or write files"),
        }),
      },
      {
        name: "memory.get_transcript",
        description:
          "Get the formatted transcript for a conversation by ID. Returns the same text that Libby receives for processing.",
        inputSchema: z.object({
          id: z.number().describe("Conversation ID"),
        }),
      },
    ],
    events: [
      "memory.ingested",
      "memory.conversation_ready",
      "memory.processing_started",
      "memory.conversation_processed",
      "memory.processing_complete",
    ],

    async start(context: ExtensionContext) {
      ctx = context;
      fileLog(
        "INFO",
        `Memory extension starting (watchPath=${basePath}, gap=${cfg.conversationGapMinutes}min)`,
      );
      ctx.log.info("[memory] Starting memory extension...");

      // Ensure DB connection works
      try {
        getDb();
        ctx.log.info("[memory] Database connection established");
      } catch (error) {
        ctx.log.error(
          `[memory] Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      const lockResult = acquireMemoryExtensionLock(process.pid, LOCK_STALE_MS);
      isLockOwner = lockResult.acquired;
      lockState = lockResult.acquired ? "held" : "contended";

      if (!lockResult.acquired) {
        ctx.log.warn(
          `[memory] Another memory extension instance holds the singleton lock (owner pid=${lockResult.ownerPid}, heartbeatAge=${Math.round(lockResult.ageMs / 1000)}s). This instance will stay passive.`,
        );
        fileLog(
          "WARN",
          `[memory] Singleton lock contended; owner pid=${lockResult.ownerPid}, heartbeatAge=${Math.round(lockResult.ageMs / 1000)}s`,
        );
        return;
      }

      if (lockResult.stolen && lockResult.previousOwnerPid) {
        fileLog(
          "WARN",
          `[memory] Stole stale singleton lock from pid=${lockResult.previousOwnerPid} (age=${Math.round(lockResult.ageMs / 1000)}s)`,
        );
      }

      try {
        // Create XState actor
        extensionActor = createActor(memoryExtensionMachine, {
          // Do not restore machine snapshots; restoring transient states (e.g. scanning)
          // can leave actors stranded across process boundaries.
          input: {
            processId: process.pid,
            startedAt: null,
            lastHeartbeat: null,
            config: cfg,
            basePath,
            watcher: null,
            ctx,
            fileLog,
          },
        });

        // Subscribe to state changes and persist to DB
        extensionActor.subscribe((snapshot) => {
          try {
            getDb()
              .query(
                `INSERT OR REPLACE INTO memory_state_machines
                 (machine_id, state_json, process_id, updated_at)
                 VALUES ('extension', ?, ?, datetime('now'))`,
              )
              .run(JSON.stringify(toPersistableSnapshot(snapshot)), process.pid);
          } catch (error) {
            fileLog("ERROR", `Failed to persist state: ${error}`);
          }

          // Update local watcher reference
          watcher = snapshot.context.watcher;
        });

        // Start the state machine
        extensionActor.start();
        extensionActor.send({ type: "START" });

        // Subscribe to gateway heartbeat and forward to state machine
        unsubscribeHeartbeat = ctx.on("gateway.heartbeat", () => {
          if (!isLockOwner) return;

          const renewed = renewMemoryExtensionLock(process.pid);
          if (!renewed) {
            isLockOwner = false;
            lockState = "contended";
            fileLog("ERROR", "[memory] Lost singleton lock; stopping memory actor and worker");
            const stopPromise = worker?.stop();
            if (stopPromise) void stopPromise.catch(() => {});
            worker = null;
            extensionActor?.send({ type: "STOP" });
            return;
          }

          extensionActor?.send({ type: "HEARTBEAT" });
        });

        // Do not block extension registration on startup scan/watcher initialization.
        // Register immediately, then start Libby's worker once the state machine reaches "running".
        const actor = extensionActor;
        const startWorkerWhenRunning = () => {
          if (!ctx || worker) return;
          if (actor.getSnapshot().value !== "running") return;
          try {
            const libbyConfig: LibbyConfig = {
              model: cfg.model,
              timezone: cfg.timezone,
              minConversationMessages: cfg.minConversationMessages,
            };
            worker = new LibbyWorker(libbyConfig, ctx, fileLog);
            worker.start();

            // Check if there are already queued conversations from crash recovery
            const queuedCount = getQueuedCount();
            if (queuedCount > 0) {
              fileLog("INFO", `Found ${queuedCount} queued conversations from previous run`);
              worker.wake();
            }
          } catch (error) {
            fileLog(
              "ERROR",
              `Failed to start Libby worker: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };

        // Fast path for already-running snapshots and slow path for async transition completion.
        startWorkerWhenRunning();
        const runningSubscription = actor.subscribe((snapshot) => {
          if (snapshot.value !== "running") return;
          runningSubscription.unsubscribe();
          startWorkerWhenRunning();
        });
      } catch (error) {
        fileLog(
          "ERROR",
          `[memory] Startup failed after lock acquire: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (isLockOwner) {
          releaseMemoryExtensionLock(process.pid);
        }
        isLockOwner = false;
        lockState = "released";
        throw error;
      }
    },

    async stop() {
      ctx?.log.info("[memory] Stopping memory extension...");

      if (unsubscribeHeartbeat) {
        unsubscribeHeartbeat();
        unsubscribeHeartbeat = null;
      }

      // Stop Libby worker first
      if (worker) {
        await worker.stop();
        worker = null;
      }

      // Send STOP event to state machine
      if (extensionActor) {
        extensionActor.send({ type: "STOP" });
        await waitForState(extensionActor, "stopped");
        extensionActor.stop();
        extensionActor = null;
      }

      // Watcher is stopped by the state machine, just clear reference
      watcher = null;

      if (isLockOwner) {
        releaseMemoryExtensionLock(process.pid);
      }
      isLockOwner = false;
      lockState = "released";

      closeDb();
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "memory.health_check": {
          const stats = getStats();
          const s = stats.conversationsByStatus;
          const workItems = getActiveWorkItems();
          const singletonLock = getMemoryExtensionLockStatus(LOCK_STALE_MS);
          const actorState = extensionActor?.getSnapshot().value ?? "stopped";
          const lockHeldByMe = singletonLock?.ownerPid === process.pid;
          const lockLabel = singletonLock ? (lockHeldByMe ? "held" : "contended") : lockState;
          const lockAgeSec = singletonLock
            ? Math.max(0, Math.round(singletonLock.ageMs / 1000))
            : 0;
          const watcherDiag = watcher?.getDiagnostics() ?? null;

          const items: HealthItem[] = workItems.map((conv) => {
            const meta = conv.metadata
              ? (JSON.parse(conv.metadata) as Record<string, unknown>)
              : {};
            const isProcessing = conv.status === "processing";

            // Calculate elapsed time for processing items
            let elapsed = "";
            if (isProcessing && conv.statusAt) {
              const elapsedMs = Date.now() - new Date(conv.statusAt + "Z").getTime();
              elapsed =
                elapsedMs < 60_000
                  ? `${Math.round(elapsedMs / 1000)}s`
                  : `${Math.round(elapsedMs / 60_000)}m`;
            }

            // Keep keys consistent so table columns align
            let waiting = "";
            if (!isProcessing && conv.statusAt) {
              const queuedMs = Date.now() - new Date(conv.statusAt + "Z").getTime();
              waiting =
                queuedMs < 60_000
                  ? `${Math.round(queuedMs / 1000)}s`
                  : `${Math.round(queuedMs / 60_000)}m`;
            }

            const details: Record<string, string> = {
              entries: String(conv.entryCount),
              date: conv.firstMessageAt.slice(0, 10),
              transcript: isProcessing && meta.transcriptKB ? `${meta.transcriptKB}KB` : "",
              time: isProcessing && meta.timeRange ? (meta.timeRange as string) : "",
              elapsed: isProcessing ? elapsed : waiting,
            };

            return {
              id: String(conv.id),
              label: isProcessing
                ? `#${conv.id} ${((meta.cwd as string) || conv.sourceFile).replace(/^\/Users\/\w+/, "~")}`
                : `#${conv.id}`,
              status: isProcessing ? "healthy" : "inactive",
              details,
            };
          });

          const response: HealthCheckResponse = {
            ok: true,
            status: lockHeldByMe ? "healthy" : "degraded",
            label: "Memory (Transcript Ingestion + Libby)",
            metrics: [
              { label: "Singleton Lock", value: lockLabel },
              {
                label: "Lock Owner PID",
                value: singletonLock ? String(singletonLock.ownerPid) : "none",
              },
              {
                label: "Lock Age",
                value: singletonLock ? `${lockAgeSec}s` : "n/a",
              },
              { label: "Actor State", value: actorState },
              { label: "Watcher Ready", value: watcherDiag ? String(watcherDiag.ready) : "false" },
              {
                label: "Last File Change",
                value: formatElapsedSince(watcherDiag?.lastChangedAt ?? null),
              },
              {
                label: "Last Ingest",
                value: formatElapsedSince(watcherDiag?.lastIngestAt ?? null),
              },
              {
                label: "Last Ingest File",
                value: compactHomePath(watcherDiag?.lastIngestFile ?? null),
              },
              { label: "Last Error", value: watcherDiag?.lastError ?? "none" },
              { label: "Files Tracked", value: String(stats.fileCount) },
              { label: "Entries", value: String(stats.entryCount) },
              { label: "Queued", value: String(s.queued || 0) },
              { label: "Processing", value: String(s.processing || 0) },
              { label: "Ready", value: String(s.ready || 0) },
              { label: "Archived", value: String(s.archived || 0) },
              { label: "Skipped", value: String(s.skipped || 0) },
              { label: "Active", value: String(s.active || 0) },
            ],
            items,
          };
          return response;
        }

        case "memory.ingest": {
          const file = params.file as string | undefined;
          const dir = params.dir as string | undefined;
          const reimport = params.reimport as boolean | undefined;

          if (!file && !dir) {
            throw new Error('Provide either "file" or "dir" parameter');
          }

          if (file) {
            const expanded = expandPath(file);
            // Determine base path: if file is under a known directory, use that as base
            // Otherwise, use the file's parent directory
            const fileBasePath = findBasePath(expanded, basePath);
            fileLog(
              "INFO",
              `Manual ingest: file=${expanded}, base=${fileBasePath}, reimport=${!!reimport}`,
            );
            const result = ingestFile(expanded, fileBasePath, cfg.conversationGapMinutes, {
              forceReimport: reimport,
            });
            ctx?.emit("memory.ingested", result);
            return result;
          }

          if (dir) {
            const expanded = expandPath(dir);
            fileLog("INFO", `Manual ingest: dir=${expanded}, reimport=${!!reimport}`);
            const result = ingestDirectory(expanded, cfg.conversationGapMinutes, {
              forceReimport: reimport,
            });
            ctx?.emit("memory.ingested", result);
            return result;
          }

          return { error: "unreachable" };
        }

        case "memory.conversations": {
          const status = params.status as string | undefined;
          const limit = (params.limit as number) || 50;

          const d = getDb();
          let query: string;
          const queryParams: unknown[] = [];

          const selectCols = `id, session_id AS sessionId, source_file AS sourceFile,
              first_message_at AS firstMessageAt,
              last_message_at AS lastMessageAt, entry_count AS entryCount,
              status, strategy, summary, processed_at AS processedAt,
              status_at AS statusAt, metadata,
              created_at AS createdAt`;

          if (status) {
            query = `SELECT ${selectCols} FROM memory_conversations
            WHERE status = ?
            ORDER BY last_message_at DESC
            LIMIT ?`;
            queryParams.push(status, limit);
          } else {
            query = `SELECT ${selectCols} FROM memory_conversations
            ORDER BY last_message_at DESC
            LIMIT ?`;
            queryParams.push(limit);
          }

          const conversations = d.query(query).all(...(queryParams as [string, number] | [number]));
          return { conversations, count: conversations.length };
        }

        case "memory.process": {
          const batchSize = (params.batchSize as number) || cfg.processBatchSize;

          const readyCount = getReadyConversations().length;
          const alreadyQueued = getQueuedCount();

          if (readyCount === 0 && alreadyQueued === 0) {
            return {
              status: "nothing_to_do",
              readyConversations: 0,
              queuedConversations: 0,
              message: "No conversations ready or queued for processing.",
            };
          }

          // Queue up to batchSize conversations (ready → queued)
          const newlyQueued = readyCount > 0 ? queueConversations(batchSize) : 0;
          const totalQueued = alreadyQueued + newlyQueued;

          fileLog(
            "INFO",
            `Libby: Queued ${newlyQueued} conversations (${totalQueued} total in queue)`,
          );

          // Wake the worker if it's sleeping
          worker?.wake();

          return {
            status: "queued",
            newlyQueued,
            totalQueued,
            readyConversations: readyCount - newlyQueued,
            message: `Queued ${newlyQueued} conversations (${totalQueued} total). Worker is processing. Watch memory.log for progress.`,
          };
        }

        case "memory.process_conversation": {
          const id = params.id as number;
          const dryRun = (params.dryRun as boolean) || false;

          // Look up conversation
          const d = getDb();
          const conv = d
            .query(
              `SELECT
                id, session_id AS sessionId, source_file AS sourceFile,
                first_message_at AS firstMessageAt,
                last_message_at AS lastMessageAt, entry_count AS entryCount,
                status, strategy, summary, processed_at AS processedAt,
                created_at AS createdAt
              FROM memory_conversations WHERE id = ?`,
            )
            .get(id) as Record<string, unknown> | null;

          if (!conv) {
            throw new Error(`Conversation ${id} not found`);
          }

          const originalStatus = conv.status as string;

          // Format transcript preview
          const entries = getEntriesForConversation(id);
          if (entries.length === 0) {
            return { error: "No entries found for this conversation", conversationId: id };
          }

          const transcript = formatTranscript(conv as any, entries, cfg.timezone);
          const preview = {
            conversationId: id,
            sessionId: conv.sessionId,
            date: transcript.date,
            timeRange: transcript.timeRange,
            cwd: transcript.primaryCwd,
            entryCount: transcript.entryCount,
            chars: transcript.text.length,
            status: originalStatus,
          };

          if (dryRun) {
            return {
              ...preview,
              dryRun: true,
              transcript:
                transcript.text.slice(0, 2000) + (transcript.text.length > 2000 ? "\n..." : ""),
            };
          }

          // Queue this specific conversation for processing
          if (originalStatus !== "queued") {
            fileLog("INFO", `Queuing conversation ${id} for processing (was: ${originalStatus})`);
            updateConversationStatus(id, "queued");
          }

          // Wake the worker to pick it up
          worker?.wake();

          return {
            ...preview,
            status: "queued",
            message: `Conversation ${id} queued for processing. Watch memory.log for progress.`,
          };
        }

        case "memory.get_transcript": {
          const id = params.id as number;

          const d = getDb();
          const conv = d
            .query(
              `SELECT
                id, session_id AS sessionId, source_file AS sourceFile,
                first_message_at AS firstMessageAt,
                last_message_at AS lastMessageAt, entry_count AS entryCount,
                status, summary
              FROM memory_conversations WHERE id = ?`,
            )
            .get(id) as Record<string, unknown> | null;

          if (!conv) {
            throw new Error(`Conversation ${id} not found`);
          }

          const entries = getEntriesForConversation(id);
          if (entries.length === 0) {
            return { error: "No entries found for this conversation", conversationId: id };
          }

          const transcript = formatTranscript(conv as any, entries, cfg.timezone);

          return {
            conversationId: id,
            status: conv.status,
            summary: conv.summary,
            date: transcript.date,
            timeRange: transcript.timeRange,
            cwd: transcript.primaryCwd,
            entryCount: transcript.entryCount,
            chars: transcript.text.length,
            transcript: transcript.text,
          };
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      try {
        const stats = getStats();
        const singletonLock = getMemoryExtensionLockStatus(LOCK_STALE_MS);
        return {
          ok: singletonLock?.ownerPid === process.pid,
          details: {
            fileCount: stats.fileCount,
            entryCount: stats.entryCount,
            conversations: stats.conversationsByStatus,
            watchPath: cfg.watchPath,
            singletonLock: {
              state: lockState,
              ownerPid: singletonLock?.ownerPid ?? null,
              heldByCurrentProcess: singletonLock?.ownerPid === process.pid,
              heartbeatAgeMs: singletonLock?.ageMs ?? null,
              stale: singletonLock?.stale ?? null,
            },
          },
        };
      } catch {
        return { ok: false, details: { error: "Database not accessible" } };
      }
    },
  };
}

/**
 * Determine the base path for a file.
 * If the file is under the configured watchPath (or its -backup sibling), use that.
 * Otherwise use the directory being imported from.
 */
function findBasePath(filePath: string, configuredBasePath: string): string {
  // Check if file is under the configured watch path
  if (filePath.startsWith(configuredBasePath + "/")) return configuredBasePath;

  // Check common backup pattern (e.g., ~/.claude/projects-backup)
  const backupPath = configuredBasePath + "-backup";
  if (filePath.startsWith(backupPath + "/")) return backupPath;

  // Fallback: use parent directory
  return filePath.substring(0, filePath.lastIndexOf("/"));
}

export default createMemoryExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createMemoryExtension);
