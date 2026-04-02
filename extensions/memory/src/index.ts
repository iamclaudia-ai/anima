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
 * 4. Register gateway.heartbeat handler for singleton lock renewal
 * 5. Start a scheduler actor for ready/queue progression
 *
 * All files are keyed relative to watchPath, so importing from
 * ~/.claude/projects-backup and watching ~/.claude/projects produce
 * the same keys — no double imports.
 */

import type {
  AnimaExtension,
  ExtensionContext,
  HealthCheckResponse,
  HealthItem,
  LoggerLike,
} from "@anima/shared";
import { createStandardExtension } from "@anima/extension-host";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  transitionActiveConversationsByCwd,
  getRecentTranscriptEntries,
  getRecentArchivedSummaries,
  searchMemory,
  ftsTableExists,
  getCalendarData,
  getDayConversations,
  getMonthRange,
} from "./db";
import { ingestFile, ingestDirectoryCooperative } from "./ingest";
import { MemoryWatcher } from "./watcher";
import { formatTranscript } from "./transcript-formatter";
import { LibbyWorker, pushMemoryChanges, type LibbyConfig } from "./libby";
import { memoryExtensionMachine } from "./state-machine";
import { ingestMemoryDocument, scanAndIngestMemoryDirCooperative } from "./document-ingest";
import { DocumentWatcher } from "./document-watcher";
import { RepoSyncService } from "./repo-sync";
import { MemoryScheduler } from "./scheduler";

const noopLogger: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
};

let traceLog: LoggerLike = noopLogger;

function fileLog(level: string, msg: string): void {
  if (level === "ERROR") traceLog.error(msg);
  else if (level === "WARN") traceLog.warn(msg);
  else traceLog.info(msg);
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
  /**
   * File exclusion patterns for ingestion.
   * Absolute patterns (`/` or `~`) match absolute watched file paths.
   * Relative patterns match the computed file key under watchPath.
   */
  exclude?: string[];
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
  exclude: [],
};

const LOCK_STALE_MS = 3 * 60 * 1000;

interface MemoryExtensionRuntime {
  ctx: ExtensionContext;
  watcher: MemoryWatcher | null;
  docWatcher: DocumentWatcher | null;
  worker: LibbyWorker | null;
  repoSync: RepoSyncService | null;
  scheduler: MemoryScheduler | null;
  extensionActor: ActorRefFrom<typeof memoryExtensionMachine> | null;
  isLockOwner: boolean;
  lockState: "held" | "contended" | "released";
  unsubscribeHeartbeat: (() => void) | null;
}

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

export function createMemoryExtension(config: MemoryConfig = {}): AnimaExtension {
  const defined = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  const cfg: Required<MemoryConfig> = { ...DEFAULT_CONFIG, ...defined };

  // Expand ~ once
  const expandPath = (p: string) => p.replace(/^~/, homedir());
  const basePath = expandPath(cfg.watchPath);

  const memoryRoot = join(homedir(), "memory");
  const methods = [
    {
      name: "memory.health_check",
      description: "Return memory system stats: file count, entry count, conversation breakdown",
      inputSchema: z.object({}),
      execution: { lane: "control", concurrency: "parallel" } as const,
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
      execution: { lane: "write", concurrency: "serial" } as const,
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
      execution: { lane: "read", concurrency: "parallel" } as const,
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
      execution: { lane: "write", concurrency: "serial" } as const,
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
      execution: { lane: "write", concurrency: "serial" } as const,
    },
    {
      name: "memory.get_transcript",
      description:
        "Get the formatted transcript for a conversation by ID. Returns the same text that Libby receives for processing.",
      inputSchema: z.object({
        id: z.number().describe("Conversation ID"),
      }),
      execution: { lane: "read", concurrency: "parallel" } as const,
    },
    {
      name: "memory.transition_conversation",
      description:
        "Mark all active conversations for a workspace as ready for Libby processing. Called when user switches sessions so previous conversations enter the pipeline immediately instead of waiting for the 60-minute gap timer.",
      inputSchema: z.object({
        cwd: z
          .string()
          .describe(
            "Workspace directory — all active conversations matching this CWD will transition",
          ),
      }),
      execution: { lane: "write", concurrency: "serial" } as const,
    },
    {
      name: "memory.search",
      description:
        "Full-text search across conversation summaries and memory documents. Uses FTS5 with BM25 ranking.",
      inputSchema: z.object({
        query: z.string().describe("Search query (supports natural language)"),
        limit: z.number().optional().default(20).describe("Max results to return"),
        category: z
          .string()
          .optional()
          .describe(
            "Filter by category (episodes, milestones, insights, relationships, projects, core, personas, summary)",
          ),
        cwd: z.string().optional().describe("Filter by workspace directory"),
        dateFrom: z.string().optional().describe("Filter results from this date (ISO format)"),
        dateTo: z.string().optional().describe("Filter results up to this date (ISO format)"),
      }),
      execution: { lane: "read", concurrency: "parallel" } as const,
    },
    {
      name: "memory.get_session_context",
      description:
        "Get recent conversation context for session continuity. Returns the last N transcript entries across all sessions in the workspace plus recent archived summaries.",
      inputSchema: z.object({
        cwd: z.string().describe("Workspace directory to scope lookup"),
        includeAllSummaries: z
          .boolean()
          .optional()
          .default(false)
          .describe("When true, archived summaries are drawn across all workspaces"),
        maxRecentMessages: z
          .number()
          .optional()
          .default(20)
          .describe("Max recent messages to return"),
        maxSummaries: z.number().optional().default(5).describe("Max archived summaries to return"),
      }),
      execution: { lane: "read", concurrency: "parallel" } as const,
    },
    {
      name: "memory.calendar",
      description:
        "Get conversation counts per day for a given month. Returns calendar heatmap data.",
      inputSchema: z.object({
        month: z.string().describe("Year-month in YYYY-MM format (e.g., 2026-03)"),
      }),
      execution: { lane: "read", concurrency: "parallel" } as const,
    },
    {
      name: "memory.day",
      description:
        "Get all conversations for a specific day, ordered by time. Returns timeline data.",
      inputSchema: z.object({
        date: z.string().describe("Date in YYYY-MM-DD format"),
      }),
      execution: { lane: "read", concurrency: "parallel" } as const,
    },
    {
      name: "memory.month_range",
      description: "Get the earliest and latest months that have conversation data.",
      inputSchema: z.object({}),
      execution: { lane: "read", concurrency: "parallel" } as const,
    },
    {
      name: "memory.get_episode",
      description:
        "Get the full episode markdown file for a conversation. Returns the Libby-generated narrative from ~/memory/episodes/.",
      inputSchema: z.object({
        id: z.number().describe("Conversation ID"),
      }),
      execution: { lane: "read", concurrency: "parallel" } as const,
    },
  ];

  async function handleMemoryMethod(
    runtime: MemoryExtensionRuntime,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const ctx = runtime.ctx;
    switch (method) {
      case "memory.health_check": {
        const startedAt = Date.now();
        const stats = getStats();
        const s = stats.conversationsByStatus;
        const workItems = getActiveWorkItems();
        const singletonLock = getMemoryExtensionLockStatus(LOCK_STALE_MS);
        const actorState = runtime.extensionActor?.getSnapshot().value ?? "stopped";
        const lockHeldByMe = singletonLock?.ownerPid === process.pid;
        const lockLabel = singletonLock ? (lockHeldByMe ? "held" : "contended") : runtime.lockState;
        const lockAgeSec = singletonLock ? Math.max(0, Math.round(singletonLock.ageMs / 1000)) : 0;
        const watcherDiag = runtime.watcher?.getDiagnostics() ?? null;
        const schedulerDiag = runtime.scheduler?.getDiagnostics() ?? null;
        const repoSyncDiag = runtime.repoSync?.getDiagnostics() ?? null;

        const statusDisplay: Record<
          string,
          { healthStatus: "healthy" | "inactive" | "stale" | "dead"; icon: string }
        > = {
          processing: { healthStatus: "healthy", icon: "⚙️" },
          queued: { healthStatus: "inactive", icon: "⏳" },
          ready: { healthStatus: "inactive", icon: "📋" },
          active: { healthStatus: "inactive", icon: "💬" },
        };

        const items: HealthItem[] = workItems.map((conv) => {
          const meta = conv.metadata ? (JSON.parse(conv.metadata) as Record<string, unknown>) : {};
          const isProcessing = conv.status === "processing";
          const display = statusDisplay[conv.status] || { healthStatus: "inactive", icon: "" };

          // Calculate elapsed/waiting time
          let timeLabel = "";
          if (conv.statusAt) {
            const ms = Date.now() - new Date(conv.statusAt + "Z").getTime();
            timeLabel = ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
          }

          const cwdLabel = ((meta.cwd as string) || conv.sourceFile).replace(/^\/Users\/\w+/, "~");

          const details: Record<string, string> = {
            status: conv.status,
            entries: String(conv.entryCount),
            date: conv.firstMessageAt.slice(0, 10),
            transcript: isProcessing && meta.transcriptKB ? `${meta.transcriptKB}KB` : "",
            time: isProcessing && meta.timeRange ? (meta.timeRange as string) : "",
            elapsed: timeLabel,
          };

          return {
            id: String(conv.id),
            label: `${display.icon} #${conv.id} ${cwdLabel}`,
            status: display.healthStatus,
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
            {
              label: "Scheduler Running",
              value: schedulerDiag ? String(schedulerDiag.running) : "false",
            },
            {
              label: "Scheduler Last Run",
              value: formatElapsedSince(schedulerDiag?.lastRunAt ?? null),
            },
            {
              label: "Scheduler Last Ready",
              value: String(schedulerDiag?.lastReadyCount ?? 0),
            },
            {
              label: "Scheduler Last Queued",
              value: String(schedulerDiag?.lastQueuedCount ?? 0),
            },
            {
              label: "Scheduler Last Error",
              value: schedulerDiag?.lastError ?? "none",
            },
            {
              label: "Repo Sync Running",
              value: repoSyncDiag ? String(repoSyncDiag.running) : "false",
            },
            {
              label: "Repo Sync Active",
              value: repoSyncDiag ? String(repoSyncDiag.syncing) : "false",
            },
            {
              label: "Repo Sync Pending",
              value: String(repoSyncDiag?.pendingRequests ?? 0),
            },
            {
              label: "Repo Sync Last Run",
              value: formatElapsedSince(repoSyncDiag?.lastCompletedAt ?? null),
            },
            {
              label: "Repo Sync Last Error",
              value: repoSyncDiag?.lastError ?? "none",
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
        ctx?.log.info("[memory] health_check completed", {
          elapsedMs: Date.now() - startedAt,
          actorState,
          fileCount: stats.fileCount,
          queued: s.queued || 0,
          processing: s.processing || 0,
        });
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
          const startedAt = Date.now();
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
            exclude: cfg.exclude,
          });
          ctx?.log.info("[memory] ingest file completed", {
            elapsedMs: Date.now() - startedAt,
            file: expanded,
            filesProcessed: result.filesProcessed,
            entriesInserted: result.entriesInserted,
          });
          ctx?.emit("memory.ingested", result);
          return result;
        }

        if (dir) {
          const startedAt = Date.now();
          const expanded = expandPath(dir);
          fileLog("INFO", `Manual ingest: dir=${expanded}, reimport=${!!reimport}`);
          const result = await ingestDirectoryCooperative(expanded, cfg.conversationGapMinutes, {
            forceReimport: reimport,
            exclude: cfg.exclude,
          });
          ctx?.log.info("[memory] ingest dir completed", {
            elapsedMs: Date.now() - startedAt,
            dir: expanded,
            filesProcessed: result.filesProcessed,
            entriesInserted: result.entriesInserted,
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
        runtime.worker?.wake();

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
        runtime.worker?.wake();

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

      case "memory.transition_conversation": {
        const startedAt = Date.now();
        const cwd = params.cwd as string;
        const encodedCwd = cwd.replace(/\//g, "-").replace(/^-/, "");
        const pattern = `%${encodedCwd}%`;
        const changed = transitionActiveConversationsByCwd(pattern);

        if (changed > 0) {
          ctx?.log.info("[memory] Transitioned active conversations to ready", {
            cwd,
            changed,
          });
          // Wake Libby so she picks up the newly-ready conversations
          runtime.worker?.wake();
        }

        ctx?.log.info("[memory] transition_conversation completed", {
          elapsedMs: Date.now() - startedAt,
          cwd,
          transitioned: changed,
        });
        return { cwd, transitioned: changed };
      }

      case "memory.search": {
        if (!ftsTableExists()) {
          throw new Error("FTS index not available — migration may not have run yet");
        }
        const query = params.query as string;
        const results = searchMemory(query, {
          limit: params.limit as number | undefined,
          category: params.category as string | undefined,
          cwd: params.cwd as string | undefined,
          dateFrom: params.dateFrom as string | undefined,
          dateTo: params.dateTo as string | undefined,
        });
        return {
          results,
          query,
          totalResults: results.length,
        };
      }

      case "memory.get_session_context": {
        const startedAt = Date.now();
        const cwd = params.cwd as string;
        const includeAllSummaries = (params.includeAllSummaries as boolean | undefined) ?? false;
        const maxRecentMessages = (params.maxRecentMessages as number | undefined) ?? 20;
        const maxSummaries = (params.maxSummaries as number | undefined) ?? 5;

        // Recent transcript entries — query by cwd column (absolute path)
        const recentMessages = getRecentTranscriptEntries(cwd, maxRecentMessages);

        // Archived summaries are either workspace-scoped or global, depending on workspace mode.
        const pattern = includeAllSummaries
          ? "%"
          : `%${cwd.replace(/\//g, "-").replace(/^-/, "")}%`;
        const recentSummaries = getRecentArchivedSummaries(pattern, maxSummaries);

        ctx?.log.info("[memory] get_session_context completed", {
          elapsedMs: Date.now() - startedAt,
          cwd,
          includeAllSummaries,
          recentMessages: recentMessages.length,
          recentSummaries: recentSummaries.length,
        });
        return { recentMessages, recentSummaries };
      }

      case "memory.calendar": {
        const month = params.month as string;
        const days = getCalendarData(month);
        return { month, days };
      }

      case "memory.day": {
        const date = params.date as string;
        const conversations = getDayConversations(date);
        return { date, conversations, count: conversations.length };
      }

      case "memory.month_range": {
        const range = getMonthRange();
        return range ?? { earliest: null, latest: null };
      }

      case "memory.get_episode": {
        const id = params.id as number;
        const d = getDb();
        const conv = d
          .query(
            `SELECT id, first_message_at AS firstMessageAt, status
               FROM memory_conversations WHERE id = ?`,
          )
          .get(id) as { id: number; firstMessageAt: string; status: string } | null;

        if (!conv) {
          throw new Error(`Conversation ${id} not found`);
        }

        // Compute episode path using same logic as Libby
        const timestamp = new Date(conv.firstMessageAt);
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: cfg.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(timestamp);
        const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
        const [yr, mo, dy, hr, mi] = ["year", "month", "day", "hour", "minute"].map(get);

        const episodeRelPath = `episodes/${yr}-${mo}/${yr}-${mo}-${dy}-${hr}${mi}-${id}.md`;
        const episodePath = join(memoryRoot, episodeRelPath);

        if (!existsSync(episodePath)) {
          return {
            conversationId: id,
            status: conv.status,
            episodePath: episodeRelPath,
            found: false,
            content: null,
          };
        }

        const content = readFileSync(episodePath, "utf-8");
        return {
          conversationId: id,
          status: conv.status,
          episodePath: episodeRelPath,
          found: true,
          content,
        };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  function health(runtime: MemoryExtensionRuntime | null) {
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
            state: runtime?.lockState ?? "released",
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
  }

  return createStandardExtension<MemoryExtensionRuntime>({
    id: "memory",
    name: "Memory (Ingestion + Libby)",
    createRuntime(ctx) {
      return {
        ctx,
        watcher: null,
        docWatcher: null,
        worker: null,
        repoSync: null,
        scheduler: null,
        extensionActor: null,
        isLockOwner: false,
        lockState: "released",
        unsubscribeHeartbeat: null,
      };
    },
    methods: methods.map((definition) => ({
      definition,
      handle: async (params, instance) =>
        await handleMemoryMethod(instance.runtime, definition.name, params),
    })),
    events: [
      "memory.ingested",
      "memory.conversation_ready",
      "memory.processing_started",
      "memory.conversation_processed",
      "memory.processing_complete",
    ],
    async start(instance) {
      const runtime = instance.runtime;
      const ctx = runtime.ctx;
      traceLog = ctx.createLogger({ component: "trace", fileName: "memory-trace.log" });
      fileLog(
        "INFO",
        `Memory extension starting (watchPath=${basePath}, gap=${cfg.conversationGapMinutes}min)`,
      );
      ctx.log.info("[memory] Starting memory extension...");

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
      runtime.isLockOwner = lockResult.acquired;
      runtime.lockState = lockResult.acquired ? "held" : "contended";

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
        runtime.extensionActor = createActor(memoryExtensionMachine, {
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

        runtime.extensionActor.subscribe((snapshot) => {
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

          runtime.watcher = snapshot.context.watcher;
        });

        runtime.extensionActor.start();
        runtime.extensionActor.send({ type: "START" });

        runtime.unsubscribeHeartbeat = ctx.on("gateway.heartbeat", () => {
          if (!runtime.isLockOwner) return;

          const renewed = renewMemoryExtensionLock(process.pid);
          if (!renewed) {
            runtime.isLockOwner = false;
            runtime.lockState = "contended";
            fileLog("ERROR", "[memory] Lost singleton lock; stopping memory actor and worker");
            runtime.scheduler?.stop();
            runtime.scheduler = null;
            const repoSyncStop = runtime.repoSync?.stop();
            if (repoSyncStop) void repoSyncStop.catch(() => {});
            runtime.repoSync = null;
            const stopPromise = runtime.worker?.stop();
            if (stopPromise) void stopPromise.catch(() => {});
            runtime.worker = null;
            runtime.extensionActor?.send({ type: "STOP" });
            return;
          }

          runtime.extensionActor?.send({ type: "HEARTBEAT" });
        });

        const actor = runtime.extensionActor;
        const startWorkerWhenRunning = async () => {
          if (runtime.worker) return;
          if (actor.getSnapshot().value !== "running") return;
          try {
            if (ftsTableExists()) {
              fileLog("INFO", "FTS: Index available, running document scan...");
              try {
                const indexedDocs = await scanAndIngestMemoryDirCooperative(memoryRoot, fileLog);
                fileLog(
                  "INFO",
                  `FTS: Document scan complete — ${indexedDocs} new/updated documents`,
                );
              } catch (error) {
                fileLog(
                  "ERROR",
                  `FTS document scan failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }

              try {
                runtime.docWatcher = new DocumentWatcher(
                  memoryRoot,
                  async (filePath) => {
                    ingestMemoryDocument(filePath, memoryRoot, fileLog, { force: true });
                  },
                  fileLog,
                );
                runtime.docWatcher.start();
              } catch (error) {
                fileLog(
                  "ERROR",
                  `DocumentWatcher start failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            } else {
              fileLog(
                "WARN",
                "FTS: memory_search_fts table not found — migration 016 may not have run. Search will be unavailable.",
              );
            }

            runtime.repoSync = new RepoSyncService(() => pushMemoryChanges(fileLog), fileLog);
            runtime.repoSync.start();

            const libbyConfig: LibbyConfig = {
              model: cfg.model,
              timezone: cfg.timezone,
              minConversationMessages: cfg.minConversationMessages,
            };
            runtime.worker = new LibbyWorker(libbyConfig, ctx, fileLog, runtime.repoSync);
            runtime.worker.start();

            runtime.scheduler = new MemoryScheduler(
              {
                gapMinutes: cfg.conversationGapMinutes,
                autoProcess: cfg.autoProcess,
                processBatchSize: cfg.processBatchSize,
              },
              ctx,
              fileLog,
              () => runtime.worker?.wake(),
            );
            runtime.scheduler.start();

            const queuedCount = getQueuedCount();
            if (queuedCount > 0) {
              fileLog("INFO", `Found ${queuedCount} queued conversations from previous run`);
              runtime.worker.wake();
            }
          } catch (error) {
            fileLog(
              "ERROR",
              `Failed to start Libby worker: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };

        let runningSubscription: { unsubscribe(): void } | null = null;
        const maybeStartWorker = () => {
          if (actor.getSnapshot().value !== "running") return;
          runningSubscription?.unsubscribe();
          runningSubscription = null;
          void startWorkerWhenRunning();
        };
        runningSubscription = actor.subscribe(() => {
          maybeStartWorker();
        });
        maybeStartWorker();
      } catch (error) {
        fileLog(
          "ERROR",
          `[memory] Startup failed after lock acquire: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (runtime.isLockOwner) {
          releaseMemoryExtensionLock(process.pid);
        }
        runtime.isLockOwner = false;
        runtime.lockState = "released";
        throw error;
      }
    },
    async stop(instance) {
      const runtime = instance.runtime;
      const ctx = runtime.ctx;
      ctx.log.info("[memory] Stopping memory extension...");

      if (runtime.unsubscribeHeartbeat) {
        runtime.unsubscribeHeartbeat();
        runtime.unsubscribeHeartbeat = null;
      }

      if (runtime.docWatcher) {
        await runtime.docWatcher.stop();
        runtime.docWatcher = null;
      }

      if (runtime.scheduler) {
        runtime.scheduler.stop();
        runtime.scheduler = null;
      }

      if (runtime.repoSync) {
        await runtime.repoSync.stop();
        runtime.repoSync = null;
      }

      if (runtime.worker) {
        await runtime.worker.stop();
        runtime.worker = null;
      }

      if (runtime.extensionActor) {
        runtime.extensionActor.send({ type: "STOP" });
        await waitForState(runtime.extensionActor, "stopped");
        runtime.extensionActor.stop();
        runtime.extensionActor = null;
      }

      runtime.watcher = null;

      if (runtime.isLockOwner) {
        releaseMemoryExtensionLock(process.pid);
      }
      runtime.isLockOwner = false;
      runtime.lockState = "released";

      closeDb();
      traceLog = noopLogger;
    },
    health(instance) {
      return health(instance?.runtime ?? null);
    },
  })(config as Record<string, unknown>);
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
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createMemoryExtension);
