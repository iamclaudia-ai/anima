/**
 * Libby — Claudia's Librarian
 *
 * Processes conversations through a queue-based background worker.
 * Conversations are marked "queued" by memory.process, then the worker
 * picks them up one at a time: queued → processing → archived.
 *
 * Libby uses tools (Read, Write, Edit, Glob) to write memories directly
 * to ~/memory/ — no JSON extraction, no memory-writer intermediary.
 * After each conversation, episode ordering is verified and changes
 * are committed to git.
 *
 * Uses a dedicated workspace at ~/libby for Libby's sessions.
 * Each conversation gets a fresh Claude session so:
 * - JSONL history stays bounded per transcript
 * - prior transcripts do not leak into the next run's context
 * - the only long-lived identity is the in-flight session ID recorded on
 *   the conversation row for crash recovery
 *
 * The worker sleeps when idle and can be woken via AbortController
 * when new conversations are queued. Survives crashes by best-effort
 * recovery of in-flight sessions before falling back to requeueing work.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@anima/shared";
import {
  getNextQueued,
  getQueuedCount,
  getEntriesForConversation,
  getProcessingConversations,
  resetConversationToQueued,
  updateConversationStatus,
  updateConversationProcessed,
  getPreviousConversationContext,
  type ConversationRow,
} from "./db";
import { formatTranscript } from "./transcript-formatter";

// ============================================================================
// System Prompt (loaded once at module level)
// ============================================================================

const SYSTEM_PROMPT = readFileSync(join(import.meta.dir, "prompts", "libby-system.md"), "utf-8");

// Ensure ~/libby exists as Libby's working directory
const LIBBY_CWD = join(homedir(), "libby");
if (!existsSync(LIBBY_CWD)) mkdirSync(LIBBY_CWD, { recursive: true });

const MEMORY_ROOT = join(homedir(), "memory");
const LIBBY_LOGS_DIR = join(homedir(), ".anima", "memory", "libby", "logs");
if (!existsSync(LIBBY_LOGS_DIR)) mkdirSync(LIBBY_LOGS_DIR, { recursive: true });

/**
 * Compute the episode file path for a conversation.
 * Format: episodes/YYYY-MM/YYYY-MM-DD-HHMM-{convId}.md
 *
 * Uses the first entry's timestamp converted to local time for the date/time components.
 */
function computeEpisodePath(firstTimestamp: string, convId: number, timezone: string): string {
  const d = new Date(firstTimestamp);

  // Format in local timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");

  return `episodes/${year}-${month}/${year}-${month}-${day}-${hour}${minute}-${convId}.md`;
}

const LIBBY_TRANSCRIPTS_DIR = join(LIBBY_CWD, "transcripts");
if (!existsSync(LIBBY_TRANSCRIPTS_DIR)) mkdirSync(LIBBY_TRANSCRIPTS_DIR, { recursive: true });

// ============================================================================
// Types
// ============================================================================

export interface LibbyConfig {
  model: string;
  timezone: string;
  minConversationMessages: number;
}

export interface RepoSyncRequester {
  requestSync(reason?: string): void;
}

interface SessionHistoryBlock {
  type: "text" | "thinking" | "image" | "file" | "tool_use";
  content?: string;
}

interface SessionHistoryMessage {
  role: "user" | "assistant" | "compaction_boundary";
  blocks: SessionHistoryBlock[];
}

interface SessionRuntimeInfo {
  id: string;
  isActive: boolean;
  isProcessRunning: boolean;
}

// ============================================================================
// Libby Session (RPC via ctx.call)
// ============================================================================

/**
 * A per-conversation session for Libby's processing.
 *
 * Uses ctx.call() RPC to communicate with the gateway — proper
 * request/response instead of fire-and-forget WebSocket messages.
 * Creates one session for one transcript.
 * The system prompt is sent as the first message to establish Libby's identity.
 */
class LibbySession {
  private _sessionId: string | null = null;
  private initialized = false;
  promptCount = 0;

  constructor(
    private ctx: ExtensionContext,
    private model: string,
    private log: (level: string, msg: string) => void,
  ) {}

  get isOpen(): boolean {
    return this.initialized && this._sessionId !== null;
  }

  /** The Claude Code session ID for this Libby session */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Create workspace + session, send system prompt.
   * Cleans up any orphaned sessions from previous runs first.
   */
  async open(): Promise<void> {
    await this.close(); // Clean up any existing session we know about

    // Get or create Libby's workspace
    await this.ctx.call("session.get_or_create_workspace", { cwd: LIBBY_CWD });

    // Clean up orphaned sessions from previous runs (e.g. killed by HMR/restart)
    try {
      const sessions = (await this.ctx.call("session.list_sessions", { cwd: LIBBY_CWD })) as {
        sessions: Array<{ id: string }>;
      };
      if (sessions?.sessions?.length) {
        for (const s of sessions.sessions) {
          try {
            await this.ctx.call("session.close_session", { sessionId: s.id });
          } catch {
            // Already closed or gone
          }
        }
      }
    } catch {
      // list_sessions may fail if workspace doesn't exist yet — fine
    }

    // Create a session
    const result = (await this.ctx.call("session.create_session", {
      cwd: LIBBY_CWD,
      model: this.model,
    })) as {
      sessionId: string;
    };
    this._sessionId = result.sessionId;
    if (!this._sessionId) throw new Error("Failed to create session");

    // Send system prompt as first message
    const initPrompt = `${SYSTEM_PROMPT}\n\n---\n\nYou are now ready to process conversation transcripts. For each transcript I send, use your tools to write memories to ~/memory/, then respond with a SUMMARY or SKIP line.\n\nRespond with "ready" to confirm you understand.`;

    const initResult = (await this.ctx.call("session.send_prompt", {
      sessionId: this._sessionId,
      content: initPrompt,
      streaming: false,
    })) as { text: string; stopReason?: string };

    if (!initResult.text) {
      const reason = initResult.stopReason || "unknown";
      throw new Error(
        `System prompt got no response (stop_reason: ${reason}). ` +
          `Check API credentials and model availability.`,
      );
    }

    this.initialized = true;
    this.promptCount = 0;
  }

  /**
   * Send a transcript for processing and return Libby's response.
   *
   * Libby uses tools (Read/Write/Edit) to write memories directly,
   * then responds with SUMMARY or SKIP. The runtime handles tool
   * execution automatically via bypassPermissions.
   *
   * Fresh session per conversation — no compaction overhead.
   * Previous context is injected via DB-backed summaries.
   */
  async processTranscript(content: string): Promise<string> {
    if (!this._sessionId || !this.initialized) {
      throw new Error("Session not initialized");
    }

    this.promptCount++;

    const result = (await Promise.race([
      this.ctx.call("session.send_prompt", {
        sessionId: this._sessionId,
        content,
        streaming: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`processTranscript timed out after ${PROCESS_TIMEOUT_MS / 1000}s`)),
          PROCESS_TIMEOUT_MS,
        ),
      ),
    ])) as { text: string; stopReason?: string };

    const text = result.text;
    if (!text) {
      const reason = result.stopReason || "unknown";
      throw new Error(
        `No text in prompt response (stop_reason: ${reason}). ` +
          `This may indicate expired credentials, an API error, or the model responded with only tool calls.`,
      );
    }
    return text;
  }

  /**
   * Close the session — release the runtime resources via gateway RPC.
   */
  async close(): Promise<void> {
    if (this._sessionId) {
      try {
        await this.ctx.call("session.close_session", { sessionId: this._sessionId });
      } catch {
        // Session may already be closed
      }
    }
    this._sessionId = null;
    this.initialized = false;
    this.promptCount = 0;
  }
}

// ============================================================================
// Background Worker
// ============================================================================

/** How long the worker sleeps when no queued conversations are found */
const WORKER_SLEEP_MS = 30_000;

/** Maximum time to wait for a single processTranscript call (10 minutes) */
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Background worker that processes queued conversations one at a time.
 *
 * Loop: get next queued → mark processing → send to Libby → verify → git commit → mark archived → repeat.
 * Sleeps when idle. Can be woken via wake() when new items are queued.
 * Session is reused across all conversations — auto-compaction handles context limits.
 */
export class LibbyWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private sleepAbort: AbortController | null = null;
  private session: LibbySession | null = null;

  constructor(
    private config: LibbyConfig,
    private ctx: ExtensionContext | null,
    private log: (level: string, msg: string) => void,
    private repoSync: RepoSyncRequester | null = null,
  ) {}

  /**
   * Start the background processing loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log("INFO", "Libby: Worker started");
    this.loopPromise = this.loop();
  }

  /**
   * Stop the worker and wait for the current loop iteration to finish.
   * This prevents overlapping workers when the extension hot-reloads.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.sleepAbort?.abort();
    // Wait for the loop to finish its current iteration
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
    this.log("INFO", "Libby: Worker stopped");
  }

  /**
   * Wake the worker from sleep to check for new queued items.
   * Called when memory.process queues new conversations.
   */
  wake(): void {
    this.sleepAbort?.abort();
  }

  /**
   * Main processing loop — runs until stop() is called.
   */
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // Safety: if something is already processing (e.g. zombie from a crashed worker),
        // don't start another one until we reconcile the in-flight work.
        const alreadyProcessing = getProcessingConversations();
        if (alreadyProcessing.length > 0) {
          const handled = await this.reconcileProcessingConversations(alreadyProcessing);
          if (!handled) {
            this.log(
              "INFO",
              `Libby: Waiting — ${alreadyProcessing.length} conversation(s) already processing`,
            );
            await this.sleep(WORKER_SLEEP_MS);
          }
          continue;
        }

        const conv = getNextQueued();

        if (conv) {
          await this.processOne(conv);
        } else {
          await this.sleep(WORKER_SLEEP_MS);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log("ERROR", `Libby: Worker loop error: ${msg}`);
        // Brief pause before retrying to avoid tight error loops
        await this.sleep(5000);
      }
    }
  }

  private async reconcileProcessingConversations(
    processing: Array<{ id: number; sessionId: string | null }>,
  ): Promise<boolean> {
    if (!this.ctx) return false;

    let handled = false;
    for (const conv of processing) {
      if (!conv.sessionId) {
        resetConversationToQueued(conv.id);
        this.log("WARN", `Libby: Reset conversation ${conv.id} — missing recovery session ID`);
        handled = true;
        continue;
      }

      const session = await this.getLibbySessionInfo(conv.sessionId);
      if (session?.isProcessRunning) continue;

      const rawResponse = await recoverLibbyResponse(this.ctx, conv.sessionId);
      if (rawResponse) {
        this.log("INFO", `Libby: Recovered completed response for conversation ${conv.id}`);
        await finalizeLibbyConversation(
          conv.id,
          rawResponse,
          getQueuedCount(),
          this.log,
          this.repoSync ?? undefined,
          this.ctx,
        );
      } else {
        resetConversationToQueued(conv.id);
        this.log(
          "WARN",
          `Libby: Requeued conversation ${conv.id} — no recoverable response for session ${conv.sessionId}`,
        );
      }

      try {
        await this.ctx.call("session.close_session", { sessionId: conv.sessionId });
      } catch {
        // Session may already be closed or absent in agent-host.
      }

      handled = true;
    }

    return handled;
  }

  private async getLibbySessionInfo(sessionId: string): Promise<SessionRuntimeInfo | null> {
    if (!this.ctx) return null;
    try {
      const info = (await this.ctx.call("session.get_info", { sessionId })) as {
        session?: SessionRuntimeInfo | null;
      };
      return info.session || null;
    } catch {
      return null;
    }
  }

  /**
   * Process a single conversation through Libby's tool-based pipeline.
   */
  private async processOne(conv: ConversationRow): Promise<void> {
    const queuedRemaining = getQueuedCount();

    // Skip if below minimum message count
    if (conv.entryCount < this.config.minConversationMessages) {
      updateConversationProcessed(conv.id, "skipped", "Below minimum message count");
      this.log(
        "INFO",
        `Libby: Skipped conversation ${conv.id} (${conv.entryCount} < ${this.config.minConversationMessages} min messages) [${queuedRemaining - 1} queued]`,
      );
      return;
    }

    // Get entries and format transcript
    const entries = getEntriesForConversation(conv.id);
    if (entries.length === 0) {
      updateConversationProcessed(conv.id, "skipped", "No entries found");
      this.log(
        "INFO",
        `Libby: Skipped conversation ${conv.id} (no entries) [${queuedRemaining - 1} queued]`,
      );
      return;
    }

    const transcript = formatTranscript(conv, entries, this.config.timezone);
    const transcriptKB = (transcript.text.length / 1024).toFixed(1);

    // Skip transcripts that would blow the context window (~140K usable tokens)
    const MAX_TRANSCRIPT_KB = 100;
    if (transcript.text.length / 1024 > MAX_TRANSCRIPT_KB) {
      updateConversationProcessed(
        conv.id,
        "skipped",
        `Transcript too large (${transcriptKB}KB > ${MAX_TRANSCRIPT_KB}KB)`,
      );
      this.log(
        "INFO",
        `Libby: Skipped conversation ${conv.id} (${transcriptKB}KB > ${MAX_TRANSCRIPT_KB}KB limit) [${queuedRemaining - 1} queued]`,
      );
      return;
    }

    // Pre-compute episode file path: ~/memory/episodes/YYYY-MM/YYYY-MM-DD-HHMM-{convId}.md
    const episodePath = computeEpisodePath(entries[0].timestamp, conv.id, this.config.timezone);

    // Skip if episode file already exists (duplicate processing guard)
    if (existsSync(join(homedir(), "memory", episodePath))) {
      updateConversationProcessed(
        conv.id,
        "skipped",
        `Episode file already exists: ${episodePath}`,
      );
      this.log(
        "INFO",
        `Libby: Skipped conversation ${conv.id} — episode file already exists: ${episodePath} [${queuedRemaining - 1} queued]`,
      );
      return;
    }

    this.log(
      "INFO",
      `Libby: [${conv.id}] ${transcript.date} ${transcript.timeRange} — ${entries.length} entries, ${transcriptKB}KB transcript [${queuedRemaining - 1} queued]`,
    );

    // Fresh session per conversation — no compaction overhead
    if (!this.ctx) throw new Error("Libby: No extension context — cannot create session");
    this.session = new LibbySession(this.ctx, this.config.model, this.log);
    this.log("INFO", "Libby: Opening session...");
    await this.session.open();
    this.log("INFO", "Libby: Session ready");

    // Mark as processing with metadata (include sessionId for recovery checks)
    updateConversationStatus(conv.id, "processing", {
      transcriptKB: Number(transcriptKB),
      entries: entries.length,
      date: transcript.date,
      timeRange: transcript.timeRange,
      cwd: transcript.primaryCwd,
      sessionId: this.session.sessionId,
    });

    // Look up previous conversations from same source for context
    const previousContext = getPreviousConversationContext(conv.sourceFile, conv.firstMessageAt);

    let contextBlock = "";
    if (previousContext.length > 0) {
      const ctxEntries = previousContext.map((pc) => {
        const files =
          pc.filesWritten.length > 0
            ? `\nFiles written: ${pc.filesWritten.map((f) => f.replace(homedir() + "/memory/", "")).join(", ")}`
            : "";
        return `- [${pc.date}] ${pc.summary || "(no summary)"}${files}`;
      });
      contextBlock = `\n## Context from Previous Conversations\n\nThese are summaries and files from the conversations immediately before this one in the same session. Use them to resolve ambiguous references like "this", "it", or "what we discussed".\n\n${ctxEntries.join("\n")}\n\n`;
    }

    // Build the prompt — transcript + context (system prompt already sent)
    // Include conversation ID, episode path so Libby knows exactly where to write
    const prompt = `${contextBlock}Process this conversation transcript (conversation ID: ${conv.id}).

Episode file: ~/memory/${episodePath}

FIRST write your reasoning log to ~/.anima/memory/libby/logs/${conv.id}.md, THEN write the episode to the path above and any other memories to ~/memory/, then respond with SUMMARY or SKIP:

${transcript.text}`;

    // Save transcript to ~/libby/transcripts/{id}.md for easy cross-reference
    try {
      const transcriptPath = join(LIBBY_TRANSCRIPTS_DIR, `${conv.id}.md`);
      Bun.write(transcriptPath, transcript.text);
    } catch {
      // Non-fatal — transcript saving is for debugging convenience
    }

    this.log(
      "INFO",
      `Libby: [${conv.id}] Sending ${(prompt.length / 1024).toFixed(1)}KB prompt (session prompt #${this.session.promptCount + 1})`,
    );

    try {
      // Send transcript — Libby uses tools to write files, then responds with SUMMARY/SKIP
      const startTime = Date.now();
      const rawResponse = await this.session.processTranscript(prompt);
      await finalizeLibbyConversation(
        conv.id,
        rawResponse,
        queuedRemaining,
        this.log,
        this.repoSync ?? undefined,
        this.ctx,
        startTime,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log("ERROR", `Libby: Failed conversation ${conv.id}: ${msg}`);

      // Revert to queued for retry
      updateConversationStatus(conv.id, "queued");
    } finally {
      // Always close session — fresh one per conversation
      if (this.session) {
        await this.session.close();
        this.session = null;
      }
    }
  }

  /**
   * Sleep for the given duration, but wake early if abort is signaled.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepAbort = new AbortController();
      const timeout = setTimeout(() => {
        this.sleepAbort = null;
        resolve();
      }, ms);

      this.sleepAbort.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        this.sleepAbort = null;
        resolve();
      });
    });
  }
}

// ============================================================================
// Response Parsing
// ============================================================================

interface LibbyResult {
  skipped: boolean;
  summary: string;
}

function extractAssistantText(message: SessionHistoryMessage): string {
  return message.blocks
    .filter((block) => block.type === "text" && typeof block.content === "string")
    .map((block) => block.content?.trim() || "")
    .filter(Boolean)
    .join("\n");
}

export function extractRecoveredLibbyResponse(messages: SessionHistoryMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = extractAssistantText(message);
    if (text) return text;
  }
  return null;
}

async function recoverLibbyResponse(
  ctx: ExtensionContext,
  sessionId: string,
): Promise<string | null> {
  try {
    const history = (await ctx.call("session.get_history", {
      sessionId,
      cwd: LIBBY_CWD,
      limit: 50,
      offset: 0,
    })) as { messages?: SessionHistoryMessage[] };
    return extractRecoveredLibbyResponse(history.messages || []);
  } catch {
    return null;
  }
}

/**
 * Parse Libby's response text into a result.
 * Libby responds with either "SKIP: reason" or "SUMMARY: one-liner"
 */
function parseLibbyResponse(rawText: string): LibbyResult {
  const text = rawText.trim();

  // Check for SKIP — may appear at start of line or inline after tool output
  const skipMatch = text.match(/SKIP:\s*(.+?)(?:\n|$)/i);
  if (skipMatch) {
    return { skipped: true, summary: skipMatch[1].trim() };
  }

  // Check for SUMMARY — may appear at start of line or inline after tool output
  const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
  if (summaryMatch) {
    return { skipped: false, summary: summaryMatch[1].trim() };
  }

  // Fallback: use the last non-empty line as summary
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1]?.trim() || "Processed by Libby";
  return { skipped: false, summary: lastLine };
}

async function finalizeLibbyConversation(
  conversationId: number,
  rawResponse: string,
  queuedRemaining: number,
  log: (level: string, msg: string) => void,
  repoSync?: RepoSyncRequester,
  ctx?: ExtensionContext,
  startTimeMs?: number,
): Promise<void> {
  const elapsed =
    typeof startTimeMs === "number" ? ((Date.now() - startTimeMs) / 1000).toFixed(1) : "recovered";
  log(
    "INFO",
    `Libby: [${conversationId}] Response received in ${elapsed}s (${rawResponse.length} chars)`,
  );

  const result = parseLibbyResponse(rawResponse);

  if (result.skipped) {
    updateConversationProcessed(conversationId, "skipped", result.summary);
    log("INFO", `Libby: [${conversationId}] Skipped in ${elapsed}s — ${result.summary}`);
  } else {
    const filesWritten = await commitMemoryChanges(conversationId, result.summary, log);
    const reviewReason = await verifyProcessing(conversationId, result.summary, filesWritten, log);

    if (reviewReason) {
      updateConversationProcessed(conversationId, "review", result.summary, filesWritten);
      log("WARN", `Libby: [${conversationId}] Flagged for review in ${elapsed}s — ${reviewReason}`);
    } else {
      updateConversationProcessed(conversationId, "archived", result.summary, filesWritten);
      log(
        "INFO",
        `Libby: [${conversationId}] Archived in ${elapsed}s — ${filesWritten.length} files changed`,
      );
    }

    if (filesWritten.length > 0) {
      repoSync?.requestSync(`conversation:${conversationId}`);
    }
  }

  ctx?.emit("memory.conversation_processed", {
    conversationId,
    status: result.skipped ? "skipped" : "archived",
    queued: Math.max(queuedRemaining - 1, 0),
  });
}

// ============================================================================
// Verification
// ============================================================================

/** Minimum summary length that indicates a meaningful conversation was processed */
const MIN_MEANINGFUL_SUMMARY_LENGTH = 50;

/**
 * Verify that Libby's processing looks correct.
 * Returns a reason string if flagging for review, or null if everything looks good.
 *
 * Checks:
 * 1. Long summary but 0 files written → Libby understood but didn't write
 * 2. Reasoning log planned writes that don't match actual files → mismatch
 */
async function verifyProcessing(
  conversationId: number,
  summary: string,
  filesWritten: string[],
  log: (level: string, msg: string) => void,
): Promise<string | null> {
  // Check 1: Meaningful summary but no files written
  // Filter out the log file itself from the count — only count memory files
  const memoryFiles = filesWritten.filter((f) => !f.includes("libby/logs/"));
  if (memoryFiles.length === 0 && summary.length >= MIN_MEANINGFUL_SUMMARY_LENGTH) {
    log(
      "WARN",
      `Libby: [${conversationId}] Verification failed: summary is ${summary.length} chars but 0 memory files written`,
    );
    return `Summary produced (${summary.length} chars) but no memory files written`;
  }

  // Check 2: Reasoning log exists and planned writes don't match actual writes
  // Libby should use the numeric conversation ID, but may use session UUID — check both
  const logPath = join(LIBBY_LOGS_DIR, `${conversationId}.md`);
  const logExists = existsSync(logPath) || filesWritten.some((f) => f.includes("libby/logs/"));
  if (logExists && existsSync(logPath)) {
    try {
      const logContent = await readFile(logPath, "utf-8");
      const plannedPaths = parseLogPlannedFiles(logContent);

      if (plannedPaths.length > 0 && memoryFiles.length === 0) {
        log(
          "WARN",
          `Libby: [${conversationId}] Verification failed: log planned ${plannedPaths.length} files but 0 were written`,
        );
        return `Reasoning log planned ${plannedPaths.length} file(s) but none were written`;
      }
    } catch {
      // Log parsing failed — not a reason to flag
    }
  } else if (memoryFiles.length > 0 && !logExists) {
    // Files were written but no reasoning log — worth noting but not blocking
    log("WARN", `Libby: [${conversationId}] No reasoning log found at ${logPath}`);
  }

  return null;
}

/**
 * Parse the reasoning log to extract planned file paths.
 * Looks for lines like "1. **episodes/...** —" or "- episodes/..." in the "Files to write/edit" section.
 */
function parseLogPlannedFiles(logContent: string): string[] {
  const paths: string[] = [];
  // Match lines with bold paths like **episodes/2025-10/...**  or **projects/...**
  const boldPathRegex = /\*\*([a-z][\w-]+\/[\w/.-]+)\*\*/gi;
  let match: RegExpExecArray | null;
  while ((match = boldPathRegex.exec(logContent)) !== null) {
    const p = match[1];
    // Filter to only memory-relevant paths (not libby/logs)
    if (!p.startsWith("libby/logs")) {
      paths.push(p);
    }
  }
  return paths;
}

async function runCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

// ============================================================================
// Post-Processing
// ============================================================================

/**
 * Git add and commit all changes in ~/memory/.
 * Returns list of files that were changed (from git diff).
 */
async function commitMemoryChanges(
  conversationId: number,
  summary: string,
  log: (level: string, msg: string) => void,
): Promise<string[]> {
  try {
    // Stage all changes
    const addResult = await runCommand(["git", "add", "-A"], MEMORY_ROOT);
    if (addResult.exitCode !== 0) {
      throw new Error(`git add exited with code ${addResult.exitCode}: ${addResult.stderr}`);
    }

    // Check if there are staged changes
    const quietDiff = await runCommand(["git", "diff", "--cached", "--quiet"], MEMORY_ROOT);
    if (quietDiff.exitCode === 0) {
      return [];
    }
    if (quietDiff.exitCode !== 1) {
      throw new Error(
        `git diff --cached --quiet exited with code ${quietDiff.exitCode}: ${quietDiff.stderr}`,
      );
    }

    // Get list of changed files before committing
    const diffResult = await runCommand(["git", "diff", "--cached", "--name-only"], MEMORY_ROOT);
    if (diffResult.exitCode !== 0) {
      throw new Error(
        `git diff --cached --name-only exited with code ${diffResult.exitCode}: ${diffResult.stderr}`,
      );
    }
    const filesWritten = diffResult.stdout
      ? diffResult.stdout.split("\n").map((f) => join(MEMORY_ROOT, f))
      : [];

    // Commit with summary
    const commitMsg = `libby(${conversationId}): ${summary.slice(0, 100)}`;
    const commitResult = await runCommand(["git", "commit", "-m", commitMsg], MEMORY_ROOT);
    if (commitResult.exitCode !== 0) {
      throw new Error(
        `git commit exited with code ${commitResult.exitCode}: ${commitResult.stderr}`,
      );
    }

    // Log the actual commit hash to verify it really committed
    const commitHashResult = await runCommand(["git", "rev-parse", "--short", "HEAD"], MEMORY_ROOT);
    if (commitHashResult.exitCode !== 0) {
      throw new Error(
        `git rev-parse exited with code ${commitHashResult.exitCode}: ${commitHashResult.stderr}`,
      );
    }
    const commitHash = commitHashResult.stdout;
    log("INFO", `Libby: Git committed ${filesWritten.length} files (${commitHash})`);

    return filesWritten;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", `Libby: Git commit failed: ${msg}`);
    return [];
  }
}

/**
 * Pull with rebase then push ~/memory/ to remote.
 * Best-effort — network failures are logged but don't block processing.
 */
export async function pushMemoryChanges(log: (level: string, msg: string) => void): Promise<void> {
  try {
    // Rebase local commits on top of remote to keep history linear
    const pullResult = await runCommand(["git", "pull", "--rebase"], MEMORY_ROOT);
    if (pullResult.exitCode !== 0) {
      // If rebase fails (conflict), abort and log — don't push stale state
      await runCommand(["git", "rebase", "--abort"], MEMORY_ROOT);
      log("ERROR", `Libby: Git pull --rebase failed (aborted): ${pullResult.stderr}`);
      return;
    }

    const pushResult = await runCommand(["git", "push"], MEMORY_ROOT);
    if (pushResult.exitCode !== 0) {
      log("ERROR", `Libby: Git push failed: ${pushResult.stderr}`);
      return;
    }

    log("INFO", "Libby: Git pushed to remote");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", `Libby: Git push failed: ${msg}`);
  }
}
