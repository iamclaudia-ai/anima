/**
 * Session Extension
 *
 * Owns all session and workspace lifecycle — the "brain" of Claudia's session management.
 * Session lifecycle, workspace management, and Claude SDK integration.
 *
 * Gateway is a pure hub: this extension handles create, prompt, history, switch, etc.
 * Other extensions interact via ctx.call("session.*") through the gateway hub.
 *
 * Method naming: session.verb_noun (e.g. session.health_check)
 */

import { z } from "zod";
import type {
  AnimaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  HealthCheckResponse,
} from "@anima/shared";
import { createLogger, loadConfig, PERSISTENT_SESSION_ID } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { AgentHostClient } from "./agent-client";
import {
  parseSessionFile,
  parseSessionFilePaginated,
  parseSessionUsage,
  resolveSessionPath,
} from "./parse-session";
import {
  listWorkspaces,
  getWorkspace,
  getWorkspaceByCwd,
  getOrCreateWorkspace,
  deleteWorkspace,
  closeDb,
} from "./workspace";
import {
  closeSessionDb,
  getStoredSession,
  getWorkspaceActiveSession,
  listTaskSessions,
  listWorkspaceSessions,
  setWorkspaceActiveSession,
  touchSession,
  upsertSession,
  type RuntimeStatus,
  type StoredSession,
} from "./session-store";
import { resolvePersistentSessionForCwd, rotatePersistentSessions } from "./persistent-sessions";

const log = createLogger("SessionExt", join(homedir(), ".anima", "logs", "session.log"));

interface AgentHostSessionInfo {
  id: string;
  cwd: string;
  model: string;
  isActive: boolean;
  isProcessRunning: boolean;
  createdAt: string;
  lastActivity: string;
  healthy: boolean;
  stale: boolean;
}

interface SessionRuntimeConfig {
  model: string;
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  systemPrompt: string | null;
}

const MEMORY_TRANSITION_TIMEOUT_MS = 1500;
const MEMORY_CONTEXT_TIMEOUT_MS = 2000;

// ── Session Discovery ────────────────────────────────────────

interface SessionIndexEntry {
  sessionId: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstPrompt?: string;
  gitBranch?: string;
}

/**
 * Get list of child directories from a given path.
 * Expands ~ to home directory.
 * Returns directory names sorted alphabetically.
 */
function getDirectories(path: string): string[] {
  try {
    // Expand ~ to home directory
    const expandedPath = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

    if (!existsSync(expandedPath)) {
      return [];
    }

    const stat = statSync(expandedPath);
    if (!stat.isDirectory()) {
      return [];
    }

    // Read directory entries
    const entries = readdirSync(expandedPath, { withFileTypes: true });

    // Filter to directories only, exclude hidden directories (starting with .)
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();

    return directories;
  } catch (error) {
    log.warn("Failed to read directories", { path, error: String(error) });
    return [];
  }
}

/**
 * Resolve the Claude Code project directory for a given CWD.
 * Claude Code encodes paths by replacing / with - (dash).
 */
function resolveProjectDir(cwd: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  // Primary: Claude Code encodes cwd by replacing / with - (dash)
  const encodedCwd = cwd.replace(/\//g, "-");
  const primaryDir = join(projectsDir, encodedCwd);
  if (existsSync(primaryDir)) return primaryDir;

  // Fallback: scan for matching originalPath in sessions-index.json
  const dirs = readdirSync(projectsDir);
  for (const dir of dirs) {
    const indexPath = join(projectsDir, dir, "sessions-index.json");
    if (!existsSync(indexPath)) continue;
    try {
      const data = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (data.originalPath === cwd) return join(projectsDir, dir);
    } catch {
      // skip
    }
  }

  return null;
}

/**
 * Read the sessions-index.json if it exists, returning a map of sessionId → entry.
 */
function readSessionsIndexMap(projectDir: string): Map<string, SessionIndexEntry> {
  const map = new Map<string, SessionIndexEntry>();
  const indexPath = join(projectDir, "sessions-index.json");
  if (!existsSync(indexPath)) return map;

  try {
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const entries: SessionIndexEntry[] =
      data.entries && Array.isArray(data.entries) ? data.entries : Array.isArray(data) ? data : [];
    for (const entry of entries) {
      if (entry.sessionId) map.set(entry.sessionId, entry);
    }
  } catch {
    // skip
  }
  return map;
}

/**
 * Extract first user prompt from a JSONL session file.
 * Reads only the first ~20 lines (user message is typically line 1-2).
 *
 * Claude Code JSONL user message structure:
 *   { type: "user", message: { role: "user", content: "..." | [{type:"text",text:"..."}] } }
 */
function extractFirstPrompt(filepath: string): string | undefined {
  try {
    // Read only first 8KB — enough for the first few messages
    const buf = new Uint8Array(8192);
    const fd = openSync(filepath, "r");
    const bytesRead = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    const text = new TextDecoder().decode(buf.subarray(0, bytesRead));
    const lines = text.split("\n");

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type !== "user") continue;

        // message.content can be string or array of content blocks
        const content = msg.message?.content;
        if (typeof content === "string") return content.slice(0, 200);
        if (Array.isArray(content)) {
          const textBlock = content.find(
            (b: { type: string; text?: string }) =>
              b.type === "text" && b.text && !b.text.startsWith("<local-command-caveat>"),
          );
          if (textBlock?.text) return textBlock.text.slice(0, 200);
        }
      } catch {
        // skip — line might be truncated at buffer boundary
      }
    }
  } catch {
    // skip
  }
  return undefined;
}

/**
 * Discover sessions by scanning JSONL files on disk, enriched with index data.
 * This is the primary source of truth — the index file may be stale or incomplete.
 */
function discoverSessions(cwd: string): SessionIndexEntry[] {
  const projectDir = resolveProjectDir(cwd);
  if (!projectDir) return [];

  // Load index data for enrichment
  const indexMap = readSessionsIndexMap(projectDir);

  // Scan all .jsonl files in the project directory
  const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionIndexEntry[] = [];

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const filepath = join(projectDir, file);

    // Get file stats for timestamps
    let stats;
    try {
      stats = statSync(filepath);
    } catch {
      continue;
    }

    // Merge with index data if available
    const indexed = indexMap.get(sessionId);

    sessions.push({
      sessionId,
      created: indexed?.created || stats.birthtime.toISOString(),
      modified: indexed?.modified || stats.mtime.toISOString(),
      messageCount: indexed?.messageCount,
      firstPrompt: indexed?.firstPrompt || extractFirstPrompt(filepath),
      gitBranch: indexed?.gitBranch,
    });
  }

  return sessions;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toRuntimeStatusFromSessionEvent(type: string): RuntimeStatus | null {
  if (type === "process_started") return "running";
  if (type === "process_ended" || type === "turn_stop") return "idle";
  return null;
}

// ── Request context tracking ─────────────────────────────────

interface RequestContext {
  connectionId: string | null;
  tags: string[] | null;
  source?: string;
  responseText: string;
}

type TaskStatus = "running" | "completed" | "failed" | "interrupted";
type TaskMode = "general" | "review" | "test";

interface SessionTask {
  taskId: string;
  sessionId: string;
  agent: string;
  cwd?: string;
  worktreePath?: string;
  parentRepoPath?: string;
  continuedFromTaskId?: string;
  git?: Record<string, unknown>;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  startedAt: string;
  updatedAt: string;
  error?: string;
  outputFile?: string;
  context: {
    connectionId: string | null;
    tags: string[] | null;
  };
}

function getTaskGitInfo(
  cwd?: string,
  parentRepoPath?: string,
  worktreePath?: string,
): Record<string, unknown> | undefined {
  if (!cwd) return undefined;
  const runGit = (repoCwd: string, args: string[]): { ok: boolean; out: string } => {
    const proc = Bun.spawnSync(["git", "-C", repoCwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out =
      proc.stdout && proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "";
    return { ok: proc.exitCode === 0, out: out.trim() };
  };

  const status = runGit(cwd, ["status", "--porcelain=v1"]);
  if (!status.ok) return undefined;

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const lines = status.out ? status.out.split("\n").filter(Boolean) : [];
  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked += 1;
      continue;
    }
    const x = line[0] || " ";
    const y = line[1] || " ";
    if (x !== " ") staged += 1;
    if (y !== " ") unstaged += 1;
  }

  const branchOut = runGit(cwd, ["branch", "--show-current"]);
  const branchName = branchOut.ok && branchOut.out ? branchOut.out : undefined;
  const git: Record<string, unknown> = {
    isRepo: true,
    dirty: staged > 0 || unstaged > 0 || untracked > 0,
    staged,
    unstaged,
    untracked,
    branchName,
    branch: branchName,
  };

  if (worktreePath) {
    git.worktreeExists = existsSync(worktreePath);
  }

  if (worktreePath && parentRepoPath) {
    const taskHead = runGit(cwd, ["rev-parse", "HEAD"]);
    const parentHead = runGit(parentRepoPath, ["rev-parse", "HEAD"]);
    if (taskHead.ok && parentHead.ok && taskHead.out && parentHead.out) {
      const merged = runGit(parentRepoPath, [
        "merge-base",
        "--is-ancestor",
        taskHead.out,
        parentHead.out,
      ]);
      git.mergedToParent = merged.ok;
    }
  }

  return git;
}

/**
 * Merge tags from a primary (streaming) context and the current transient context.
 * The primary context's tags are authoritative — e.g., voice.speak from the web UI
 * should persist even when a CLI command or notification temporarily overrides
 * the requestContext for routing purposes.
 */
function mergeTags(primary: string[] | null, current: string[] | null): string[] | null {
  if (!primary && !current) return null;
  if (!primary) return current;
  if (!current) return primary;
  // Deduplicate
  const merged = new Set([...primary, ...current]);
  return Array.from(merged);
}

function normalizeTaskMode(input?: string): TaskMode {
  if (input === "review" || input === "test") return input;
  return "general";
}

function toTaskStatus(input: string | undefined): TaskStatus {
  if (input === "completed" || input === "failed" || input === "interrupted") return input;
  return "running";
}

function toSessionTaskFromStored(stored: StoredSession | null): SessionTask | null {
  if (!stored || !stored.parentSessionId) return null;
  const metadata = stored.metadata || {};
  const mode =
    stored.purpose === "review" || stored.purpose === "test" ? stored.purpose : "general";
  return {
    taskId: stored.id,
    sessionId: stored.parentSessionId,
    agent: stored.agent,
    cwd: typeof metadata.cwd === "string" ? metadata.cwd : undefined,
    worktreePath: typeof metadata.worktreePath === "string" ? metadata.worktreePath : undefined,
    parentRepoPath:
      typeof metadata.parentRepoPath === "string" ? metadata.parentRepoPath : undefined,
    continuedFromTaskId:
      typeof metadata.continuedFromTaskId === "string" ? metadata.continuedFromTaskId : undefined,
    git:
      metadata.git && typeof metadata.git === "object" && !Array.isArray(metadata.git)
        ? (metadata.git as Record<string, unknown>)
        : undefined,
    prompt: typeof metadata.prompt === "string" ? metadata.prompt : "",
    mode,
    status: toTaskStatus(stored.runtimeStatus),
    startedAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    error: typeof metadata.error === "string" ? metadata.error : undefined,
    outputFile: typeof metadata.outputFile === "string" ? metadata.outputFile : undefined,
    context: {
      connectionId: typeof metadata.connectionId === "string" ? metadata.connectionId : null,
      tags: Array.isArray(metadata.tags) ? (metadata.tags as string[]) : null,
    },
  };
}

// ── Memory Context Formatting ────────────────────────────────

interface MemoryContextResult {
  recentMessages: Array<{ role: string; content: string; timestamp: string }>;
  recentSummaries: Array<{ summary: string; firstMessageAt: string; lastMessageAt: string }>;
}

/**
 * Format memory context for injection into the system prompt.
 * Returns null if there's nothing meaningful to inject.
 */
function formatMemoryContext(memory: MemoryContextResult): string | null {
  if (memory.recentMessages.length === 0 && memory.recentSummaries.length === 0) return null;

  const parts: string[] = [
    "<claudia_memory_context>",
    "This is your automatically injected memory context for session continuity.",
    "It contains a snapshot of the most recent conversation and summaries of recent past sessions in this workspace.",
    "Use this to maintain continuity — you should know what Michael was working on and pick up naturally.",
    "Do NOT recite this context back unless asked. Just be aware of it.",
    "",
  ];

  if (memory.recentMessages.length > 0) {
    parts.push("## Last Conversation (most recent messages before this session)");
    parts.push(
      "These are the final messages from the immediately preceding session. This is what you and Michael were just doing:\n",
    );
    for (const msg of memory.recentMessages) {
      const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      const name = msg.role === "user" ? "Michael" : "Claudia";
      // Truncate very long messages to keep context reasonable
      const content = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
      parts.push(`[${time}] ${name}: ${content}`);
    }
  }

  if (memory.recentSummaries.length > 0) {
    parts.push("\n## Recent Session Summaries (chronological, oldest first)");
    parts.push(
      "These are Libby's summaries of your recent archived conversations in this workspace:\n",
    );
    for (const s of memory.recentSummaries) {
      const date = new Date(s.firstMessageAt).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      parts.push(`- [${date}] ${s.summary}`);
    }
  }

  parts.push("</claudia_memory_context>");
  return parts.join("\n");
}

// ── Extension factory ────────────────────────────────────────

export function createSessionExtension(config: Record<string, unknown> = {}): AnimaExtension {
  let ctx: ExtensionContext;

  // Load global configuration for non-session settings (e.g., agent-host URL).
  const globalConfig = loadConfig();
  const globalSessionExtConfig = (globalConfig.extensions?.session?.config || {}) as Record<
    string,
    unknown
  >;
  const configuredModel = (() => {
    if (typeof config.model === "string" && config.model.trim().length > 0) {
      return config.model.trim();
    }
    const globalModel = globalSessionExtConfig.model;
    if (typeof globalModel === "string" && globalModel.trim().length > 0) {
      return globalModel.trim();
    }
    return null;
  })();
  if (!configuredModel) {
    throw new Error(
      "Session extension requires extensions.session.config.model in ~/.anima/anima.json",
    );
  }
  const sessionConfig: SessionRuntimeConfig = {
    model: configuredModel,
    thinking: (config.thinking as boolean | undefined) ?? false,
    effort: (config.effort as "low" | "medium" | "high" | "max" | undefined) || "medium",
    systemPrompt: (config.systemPrompt as string | null | undefined) ?? null,
  };
  const agentHostConfig = globalConfig.agentHost;

  // ── Persistent Sessions ──────────────────────────────────────
  // Extensions like iMessage and Voice Mode pass PERSISTENT_SESSION_ID as
  // the sessionId. We resolve the real sessionId from ctx.store, keyed by cwd.
  // If no session exists for that cwd, we create one. If the stored session
  // is stale/dead, we replace it. Rotation is handled externally by the
  // scheduler calling session.rotate_persistent_sessions.

  async function resolvePersistentSession(cwd: string): Promise<string> {
    return resolvePersistentSessionForCwd({
      cwd,
      store: {
        getEntries: () =>
          ctx.store.get<
            Record<string, { sessionId: string; messageCount: number; createdAt: string }>
          >("persistentSessions") || {},
        setEntries: (entries) => {
          ctx.store.set("persistentSessions", entries);
        },
      },
      listActiveSessions: async () => (await agentClient.list()) as AgentHostSessionInfo[],
      createSession: async (sessionCwd) => {
        const result = (await handleMethod("session.create_session", {
          cwd: sessionCwd,
        })) as {
          sessionId: string;
        };
        return result.sessionId;
      },
      log,
      formatSessionId: sid,
    });
  }

  // Connect to agent-host via WebSocket for SDK process isolation.
  // SDK processes (Claude query()) run in the agent-host server and survive
  // gateway/extension restarts. Session extension is a thin RPC client.
  const agentClient = new AgentHostClient(agentHostConfig.url);

  // Per-session request context (for streaming events).
  // requestContexts holds the CURRENT active context (may be transient from CLI/notification).
  // primaryContexts holds the long-lived streaming context from the original caller (e.g., web UI).
  // When emitting events, tags are merged from both so voice.speak persists across tool calls.
  const requestContexts = new Map<string, RequestContext>();
  const primaryContexts = new Map<string, RequestContext>();
  const tasks = new Map<string, SessionTask>();
  const taskNotificationsSent = new Set<string>();
  const taskUnsubscribers: Array<() => void> = [];

  const StartTaskSchema = z.object({
    sessionId: z.string().describe("Parent session UUID"),
    agent: z.string().describe("Target delegated agent/provider (currently codex supported)"),
    prompt: z.string().min(1).describe("Task prompt"),
    mode: z.enum(["general", "review", "test"]).optional().default("general"),
    cwd: z.string().optional().describe("Working directory override"),
    worktree: z
      .boolean()
      .optional()
      .describe("Create a git worktree in /tmp/worktrees/<task_id> and run task there"),
    continue: z
      .string()
      .optional()
      .describe("Reuse /tmp/worktrees/<task_id> if present; otherwise run in resolved cwd"),
    model: z.string().optional().describe("Model override"),
    effort: z.string().optional().describe("Effort/reasoning override"),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    files: z.array(z.string()).optional().describe("Optional file list for review mode"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  const GetTaskSchema = z.object({
    taskId: z.string().describe("Task ID"),
  });

  const ListTasksSchema = z.object({
    sessionId: z.string().optional().describe("Filter by session ID"),
    status: z.enum(["running", "completed", "failed", "interrupted"]).optional(),
    agent: z.string().optional().describe("Filter by agent/provider"),
  });

  const InterruptTaskSchema = z.object({
    taskId: z.string().describe("Task ID"),
  });

  async function sendSessionNotification(
    sessionId: string,
    text: string,
    options?: { connectionId?: string | null; tags?: string[] | null },
  ): Promise<void> {
    const notifCtx: RequestContext = {
      connectionId: options?.connectionId ?? null,
      tags: options?.tags ?? null,
      responseText: "",
    };
    requestContexts.set(sessionId, notifCtx);

    const wrapped = `<user_notification>\n${text}\n</user_notification>`;
    const stored = getStoredSession(sessionId);
    await agentClient.prompt(
      sessionId,
      wrapped,
      undefined,
      stored?.model || sessionConfig.model,
      stored?.agent || "claude",
    );
  }

  async function notifyTaskCompletion(task: SessionTask): Promise<void> {
    if (task.status === "running") return;
    if (taskNotificationsSent.has(task.taskId)) return;
    taskNotificationsSent.add(task.taskId);

    const elapsedSecs = Math.max(
      0,
      Math.round((Date.parse(task.updatedAt) - Date.parse(task.startedAt)) / 1000),
    );
    const agentLabel =
      task.agent.length > 0 ? `${task.agent[0].toUpperCase()}${task.agent.slice(1)}` : "Agent";

    let content: string;
    if (task.status === "completed") {
      content =
        `${agentLabel} completed ${task.mode} task ${task.taskId} (${elapsedSecs}s).` +
        `${task.outputFile ? ` Output: ${task.outputFile}` : ""}`;
    } else if (task.status === "interrupted") {
      content =
        `${agentLabel} ${task.mode} task ${task.taskId} was interrupted (${elapsedSecs}s).` +
        `${task.outputFile ? ` Partial output: ${task.outputFile}` : ""}`;
    } else {
      content =
        `${agentLabel} failed ${task.mode} task ${task.taskId} (${elapsedSecs}s): ${task.error || "unknown error"}.` +
        `${task.outputFile ? ` Partial output: ${task.outputFile}` : ""}`;
    }

    try {
      await sendSessionNotification(task.sessionId, content, task.context);
      log.info("Sent task completion notification", {
        taskId: task.taskId,
        sessionId: sid(task.sessionId),
        status: task.status,
      });
    } catch (error) {
      log.warn("Failed task completion notification", {
        taskId: task.taskId,
        sessionId: sid(task.sessionId),
        status: task.status,
        error: String(error),
      });
    }
  }

  // Wire agent-host events → ctx.emit
  agentClient.on(
    "session.event",
    (event: { eventName: string; sessionId: string; [key: string]: unknown }) => {
      if (!ctx) return;

      const { eventName, sessionId, ...payload } = event;
      const reqCtx = requestContexts.get(sessionId);
      const primaryCtx = primaryContexts.get(sessionId);

      const shortSessionId = sessionId.slice(0, 8);

      // Emit stream events with envelope context restored from requestContexts.
      // We store connectionId/tags at prompt time because the extension host's
      // currentConnectionId/currentTags are restored to null after the method returns,
      // but async stream events keep firing via the manager's EventEmitter.
      //
      // Tags are merged from the primary streaming context (e.g., web UI with voice.speak)
      // and the current transient context (e.g., CLI or notification). This ensures
      // voice tags persist even when a transient caller temporarily overrides requestContexts.
      const emitOptions: { source?: string; connectionId?: string; tags?: string[] } = {};
      if (reqCtx?.source) emitOptions.source = reqCtx.source;
      // Use primary connectionId if the current context is transient (different connection)
      const connId = primaryCtx?.connectionId ?? reqCtx?.connectionId;
      if (connId) emitOptions.connectionId = connId;
      const mergedTags = mergeTags(primaryCtx?.tags ?? null, reqCtx?.tags ?? null);
      if (mergedTags) emitOptions.tags = mergedTags;

      ctx.emit(
        eventName,
        { ...payload, sessionId },
        Object.keys(emitOptions).length > 0 ? emitOptions : undefined,
      );

      const runtimeStatus =
        typeof payload.type === "string" ? toRuntimeStatusFromSessionEvent(payload.type) : null;
      if (runtimeStatus) {
        touchSession(sessionId, runtimeStatus);
      } else {
        touchSession(sessionId);
      }

      // Accumulate response text for non-streaming callers
      if (payload.type === "content_block_delta") {
        const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
        if (delta?.type === "text_delta" && delta.text && reqCtx) {
          reqCtx.responseText += delta.text;
        }
      }
    },
  );

  function wireTaskEventBridge(): void {
    const listener = (event: { taskId: string; eventName: string; [key: string]: unknown }) => {
      if (!ctx) return;
      const taskId = event.taskId;
      let task = tasks.get(taskId);
      if (!task) {
        const stored = getStoredSession(taskId);
        if (stored?.parentSessionId) {
          const metadata = stored.metadata || {};
          task = {
            taskId: stored.id,
            sessionId: stored.parentSessionId,
            agent: stored.agent,
            cwd: typeof metadata.cwd === "string" ? metadata.cwd : undefined,
            worktreePath:
              typeof metadata.worktreePath === "string" ? metadata.worktreePath : undefined,
            parentRepoPath:
              typeof metadata.parentRepoPath === "string" ? metadata.parentRepoPath : undefined,
            continuedFromTaskId:
              typeof metadata.continuedFromTaskId === "string"
                ? metadata.continuedFromTaskId
                : undefined,
            git:
              metadata.git && typeof metadata.git === "object" && !Array.isArray(metadata.git)
                ? (metadata.git as Record<string, unknown>)
                : undefined,
            prompt: typeof metadata.prompt === "string" ? metadata.prompt : "",
            mode:
              stored.purpose === "review" || stored.purpose === "test" ? stored.purpose : "general",
            status:
              stored.runtimeStatus === "completed" ||
              stored.runtimeStatus === "failed" ||
              stored.runtimeStatus === "interrupted"
                ? stored.runtimeStatus
                : "running",
            startedAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            error: typeof metadata.error === "string" ? metadata.error : undefined,
            outputFile: typeof metadata.outputFile === "string" ? metadata.outputFile : undefined,
            context: {
              connectionId:
                typeof metadata.connectionId === "string"
                  ? (metadata.connectionId as string)
                  : null,
              tags: Array.isArray(metadata.tags) ? (metadata.tags as string[]) : null,
            },
          };
          tasks.set(taskId, task);
        }
      }
      if (!task) return;

      const hostEventType = String(event.type || "");
      const payload = { ...event } as Record<string, unknown>;
      delete payload.taskId;
      delete payload.eventName;

      if (hostEventType === "stop") {
        task.status = payload.status === "interrupted" ? "interrupted" : "completed";
      } else if (hostEventType === "error") {
        task.status = "failed";
        task.error = String(payload.error || "Task failed");
      }
      if (typeof payload.outputFile === "string") {
        task.outputFile = payload.outputFile;
      }
      if (typeof payload.cwd === "string") {
        task.cwd = payload.cwd;
      }
      if (typeof payload.worktreePath === "string") {
        task.worktreePath = payload.worktreePath;
      }
      if (typeof payload.parentRepoPath === "string") {
        task.parentRepoPath = payload.parentRepoPath;
      }
      if (typeof payload.continuedFromTaskId === "string") {
        task.continuedFromTaskId = payload.continuedFromTaskId;
      }
      if (payload.git && typeof payload.git === "object" && !Array.isArray(payload.git)) {
        task.git = payload.git as Record<string, unknown>;
      }
      task.updatedAt = new Date().toISOString();
      const taskStored = getStoredSession(task.taskId);
      const parentStored = getStoredSession(task.sessionId);
      const workspaceId = taskStored?.workspaceId || parentStored?.workspaceId;
      if (workspaceId) {
        upsertSession({
          id: task.taskId,
          workspaceId,
          providerSessionId: task.taskId,
          model: taskStored?.model || parentStored?.model || sessionConfig.model,
          agent: task.agent,
          purpose: task.mode === "review" || task.mode === "test" ? task.mode : "task",
          parentSessionId: task.sessionId,
          runtimeStatus: task.status === "running" ? "running" : task.status,
          metadata: {
            prompt: task.prompt,
            cwd: task.cwd,
            worktreePath: task.worktreePath,
            parentRepoPath: task.parentRepoPath,
            continuedFromTaskId: task.continuedFromTaskId,
            git: task.git,
            outputFile: task.outputFile,
            error: task.error,
            connectionId: task.context.connectionId,
            tags: task.context.tags,
          },
        });
      }

      const mappedType =
        hostEventType === "start" ||
        hostEventType === "delta" ||
        hostEventType === "item" ||
        hostEventType === "stop" ||
        hostEventType === "error"
          ? hostEventType
          : "item";

      const emitOptions: { source?: string; connectionId?: string; tags?: string[] } = {
        source: "gateway.caller",
      };
      if (task.context.connectionId) emitOptions.connectionId = task.context.connectionId;
      if (task.context.tags) emitOptions.tags = task.context.tags;

      ctx.emit(
        `session.task.${taskId}.${mappedType}`,
        {
          taskId,
          sessionId: task.sessionId,
          agent: task.agent,
          status: task.status,
          hostEventType,
          payload,
        },
        emitOptions,
      );

      if ((hostEventType === "stop" || hostEventType === "error") && task.status !== "running") {
        void notifyTaskCompletion(task);
      }
    };

    agentClient.on("task.event", listener);
    taskUnsubscribers.push(() => {
      agentClient.removeListener("task.event", listener);
    });
  }

  // ── Method Definitions ─────────────────────────────────────

  const methods: ExtensionMethodDefinition[] = [
    {
      name: "session.create_session",
      description: "Create a new agent session for a workspace CWD",
      inputSchema: z.object({
        cwd: z.string().describe("Working directory"),
        agent: z.string().optional().describe("Agent/provider (default: claude)"),
        model: z.string().optional().describe("Model to use"),
        systemPrompt: z.string().optional().describe("System prompt"),
        thinking: z.boolean().optional().describe("Enable thinking"),
        effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Thinking effort"),
      }),
    },
    {
      name: "session.send_prompt",
      description: "Send a prompt to a session (provider-aware, streaming or await completion)",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        content: z.union([z.string(), z.array(z.unknown())]).describe("Prompt content"),
        cwd: z.string().optional().describe("CWD for auto-resume"),
        model: z.string().optional().describe("Model override for auto-resume"),
        agent: z.string().optional().describe("Agent/provider (default: claude)"),
        streaming: z.boolean().optional().default(true).describe("Stream events or await result"),
        source: z.string().optional().describe("Source for routing (e.g. imessage/+1555...)"),
      }),
    },
    {
      name: "session.interrupt_session",
      description: "Interrupt current response",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
      }),
    },
    {
      name: "session.close_session",
      description: "Close a session (kills CLI process via query.close())",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
      }),
    },
    {
      name: "session.list_sessions",
      description: "List sessions for a workspace (DB-backed metadata, filesystem-enriched)",
      inputSchema: z.object({
        cwd: z.string().describe("Workspace CWD"),
      }),
    },
    {
      name: "session.get_history",
      description: "Get session history from JSONL",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        cwd: z.string().optional().describe("Workspace CWD for fast file lookup"),
        limit: z.number().optional().default(50).describe("Max messages"),
        offset: z.number().optional().default(0).describe("Offset from most recent"),
      }),
    },
    {
      name: "session.switch_session",
      description: "Switch active session for a workspace",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID to switch to"),
        cwd: z.string().describe("Workspace CWD"),
        model: z.string().optional().describe("Model override"),
      }),
    },
    {
      name: "session.reset_session",
      description: "Create a replacement session for workspace",
      inputSchema: z.object({
        cwd: z.string().describe("Workspace CWD"),
        model: z.string().optional().describe("Model to use"),
      }),
    },
    {
      name: "session.get_info",
      description: "Get current session and extension info",
      inputSchema: z.object({
        sessionId: z.string().optional().describe("Session UUID (optional)"),
      }),
    },
    {
      name: "session.set_permission_mode",
      description: "Set CLI permission mode",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        mode: z.string().describe("Permission mode"),
      }),
    },
    {
      name: "session.send_notification",
      description:
        "Inject a notification into a session as a user message wrapped in <user_notification> tags. " +
        "Used by async task agents/extensions to notify the session when background work completes.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID to notify"),
        text: z
          .string()
          .min(1)
          .describe("Notification text (will be wrapped in <user_notification> tags)"),
      }),
    },
    {
      name: "session.send_tool_result",
      description: "Send tool result for interactive tools",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        toolUseId: z.string().describe("Tool use ID"),
        content: z.string().describe("Result content"),
        isError: z.boolean().optional().default(false).describe("Is error result"),
      }),
    },
    {
      name: "session.start_task",
      description: "Start a delegated task using a specific agent/provider",
      inputSchema: StartTaskSchema,
    },
    {
      name: "session.get_task",
      description: "Get delegated task status by task ID",
      inputSchema: GetTaskSchema,
    },
    {
      name: "session.list_tasks",
      description: "List delegated tasks with optional filters",
      inputSchema: ListTasksSchema,
    },
    {
      name: "session.interrupt_task",
      description: "Interrupt a delegated task by task ID",
      inputSchema: InterruptTaskSchema,
    },
    {
      name: "session.list_workspaces",
      description: "List all workspaces",
      inputSchema: z.object({}),
    },
    {
      name: "session.get_workspace",
      description: "Get workspace by ID",
      inputSchema: z.object({
        id: z.string().describe("Workspace ID"),
      }),
    },
    {
      name: "session.get_or_create_workspace",
      description: "Get or create workspace for CWD",
      inputSchema: z.object({
        cwd: z.string().describe("Working directory"),
        name: z.string().optional().describe("Workspace name"),
        general: z
          .boolean()
          .optional()
          .describe("Mark workspace as general so archived summaries span all workspaces"),
      }),
    },
    {
      name: "session.delete_workspace",
      description: "Delete a workspace by CWD",
      inputSchema: z.object({
        cwd: z.string().describe("Working directory of workspace to delete"),
      }),
    },
    {
      name: "session.get_directories",
      description: "List child directories from a given path (for directory browsing)",
      inputSchema: z.object({
        path: z.string().optional().default("~").describe("Path to list directories from"),
      }),
    },
    {
      name: "session.health_check",
      description: "Health status of session extension",
      inputSchema: z.object({}),
    },
    {
      name: "session.rotate_persistent_sessions",
      description:
        "Check persistent sessions against rotation policy (maxMessages/maxAgeHours) and clear stale ones. Called by scheduler on a cron.",
      inputSchema: z.object({}),
    },
    {
      name: "session.get_memory_context",
      description:
        "Preview the memory context that would be injected into a new session. Returns the raw formatted block and the underlying data. If cwd is omitted, uses the caller's working directory.",
      inputSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Workspace directory (defaults to caller's working directory)"),
      }),
    },
  ];

  // ── Method Handler ─────────────────────────────────────────

  /** Short session ID for logging */
  const sid = (id: string) => id.slice(0, 8);

  /** Truncate prompt content for logging */
  const truncate = (content: string | unknown[], maxLen = 80): string => {
    if (typeof content === "string")
      return content.length > maxLen ? content.slice(0, maxLen) + "…" : content;
    return `[${(content as unknown[]).length} blocks]`;
  };

  async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Log all method calls (except high-frequency reads)
    const isRead =
      method === "session.list_sessions" ||
      method === "session.list_workspaces" ||
      method === "session.get_workspace" ||
      method === "session.health_check" ||
      method === "session.rotate_persistent_sessions";
    if (!isRead) {
      log.info(
        `→ ${method}`,
        params.sessionId ? { sessionId: sid(params.sessionId as string) } : undefined,
      );
    }

    const start = Date.now();
    try {
      const result = await _handleMethod(method, params);
      const elapsed = Date.now() - start;
      if (!isRead && elapsed > 100) {
        log.info(`← ${method} OK (${elapsed}ms)`);
      }
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      log.error(`← ${method} FAILED (${elapsed}ms)`, {
        error: err instanceof Error ? err.message : String(err),
        ...(params.sessionId ? { sessionId: sid(params.sessionId as string) } : {}),
      });
      throw err;
    }
  }

  async function _handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "session.create_session": {
        const cwd = params.cwd as string;
        const agent = (params.agent as string | undefined) || "claude";
        const model = (params.model as string | undefined) || sessionConfig.model;
        const thinking = (params.thinking as boolean | undefined) ?? sessionConfig.thinking;
        const effort =
          (params.effort as "low" | "medium" | "high" | "max" | undefined) || sessionConfig.effort;
        let systemPrompt =
          (params.systemPrompt as string | undefined) || sessionConfig.systemPrompt || undefined;

        log.info("Creating session", {
          agent,
          cwd,
          model,
          thinking,
          effort,
        });
        const workspaceResult = getOrCreateWorkspace(cwd);

        // Transition previous session's active conversations to 'ready' for Libby,
        // and inject memory context into the new session's system prompt.
        const previousSessionId = getWorkspaceActiveSession(workspaceResult.workspace.id);
        // Transition ALL active conversations for this workspace to 'ready' for Libby
        try {
          await withTimeout(
            ctx.call("memory.transition_conversation", { cwd }),
            MEMORY_TRANSITION_TIMEOUT_MS,
            "memory.transition_conversation",
          );
        } catch (err) {
          log.warn("Failed to transition previous conversations (non-fatal)", {
            cwd,
            error: String(err),
          });
        }

        // Inject recent memory context into system prompt for continuity
        try {
          const memoryContext = (await withTimeout(
            ctx.call("memory.get_session_context", {
              cwd,
              includeAllSummaries: workspaceResult.workspace.general,
            }),
            MEMORY_CONTEXT_TIMEOUT_MS,
            "memory.get_session_context",
          )) as {
            recentMessages: Array<{ role: string; content: string; timestamp: string }>;
            recentSummaries: Array<{
              summary: string;
              firstMessageAt: string;
              lastMessageAt: string;
            }>;
          } | null;

          if (memoryContext) {
            const memoryBlock = formatMemoryContext(memoryContext);
            if (memoryBlock) {
              systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryBlock}` : memoryBlock;
              log.info("Injected memory context into session", {
                recentMessages: memoryContext.recentMessages.length,
                recentSummaries: memoryContext.recentSummaries.length,
              });
            }
          }
        } catch (err) {
          log.warn("Failed to inject memory context (non-fatal)", { error: String(err) });
        }

        const result = await agentClient.createSession({
          cwd,
          agent,
          model,
          systemPrompt,
          thinking,
          effort,
        });
        upsertSession({
          id: result.sessionId,
          workspaceId: workspaceResult.workspace.id,
          providerSessionId: result.sessionId,
          model,
          agent,
          purpose: "chat",
          runtimeStatus: "idle",
        });
        setWorkspaceActiveSession(workspaceResult.workspace.id, result.sessionId);
        log.info("Session created", { sessionId: sid(result.sessionId), cwd });
        return result;
      }

      case "session.send_prompt": {
        let sessionId = params.sessionId as string;
        const content = params.content as string | unknown[];
        const cwd = params.cwd as string | undefined;
        const model = params.model as string | undefined;
        const agent = (params.agent as string | undefined) || "claude";
        const streaming = params.streaming !== false;
        const source = params.source as string | undefined;

        // Resolve persistent session sentinel → real sessionId
        if (sessionId === PERSISTENT_SESSION_ID) {
          if (!cwd) throw new Error("cwd is required for persistent sessions");
          sessionId = await resolvePersistentSession(cwd);
          log.info("Resolved persistent session", { cwd, sessionId: sid(sessionId) });
        }

        log.info("Sending prompt", {
          agent,
          sessionId: sid(sessionId),
          streaming,
          source: source || "web",
          prompt: truncate(content),
        });

        const existing = getStoredSession(sessionId);
        const resumeModel = model || existing?.model || sessionConfig.model;
        const activeSessions = (await agentClient.list()) as AgentHostSessionInfo[];
        const activeSession = activeSessions.find((s) => s.id === sessionId);
        if (
          activeSession &&
          activeSession.isProcessRunning &&
          activeSession.model &&
          resumeModel &&
          activeSession.model !== resumeModel
        ) {
          log.warn("Detected model drift; recycling session runtime", {
            sessionId: sid(sessionId),
            runningModel: activeSession.model,
            desiredModel: resumeModel,
          });
          await agentClient.close(sessionId);
        }
        if (!existing && cwd) {
          const workspaceResult = getOrCreateWorkspace(cwd);
          upsertSession({
            id: sessionId,
            workspaceId: workspaceResult.workspace.id,
            providerSessionId: sessionId,
            model: resumeModel,
            agent,
            purpose: "chat",
            runtimeStatus: "idle",
          });
          setWorkspaceActiveSession(workspaceResult.workspace.id, sessionId);
        } else if (existing) {
          touchSession(sessionId);
        }

        // Set up request context — capture envelope data now because the extension
        // host restores currentConnectionId/currentTags after this method returns,
        // but async stream events keep firing via the manager's EventEmitter.
        const newCtx: RequestContext = {
          connectionId: ctx.connectionId,
          tags: ctx.tags,
          source,
          responseText: "",
        };

        // If there's already a primary context from a different connection (e.g., web UI
        // with voice.speak), preserve it so its tags persist through tool calls and
        // transient prompts from CLI/notifications.
        const existingPrimary = primaryContexts.get(sessionId);
        if (streaming && ctx.tags?.length) {
          // This caller has tags (e.g., voice.speak) — promote to primary
          primaryContexts.set(sessionId, newCtx);
        } else if (existingPrimary && existingPrimary.connectionId !== ctx.connectionId) {
          // Different connection without tags — don't clobber primary
          log.info("Preserving primary context", {
            sessionId: sid(sessionId),
            primaryConn: existingPrimary.connectionId?.slice(0, 8),
            transientConn: ctx.connectionId?.slice(0, 8),
          });
        }

        requestContexts.set(sessionId, newCtx);

        if (streaming) {
          // Fire and forget — events stream back via ctx.emit
          const promptStart = Date.now();
          await agentClient.prompt(sessionId, content, cwd, resumeModel, agent);

          // Log turn completion when we see turn_stop
          const turnListener = (event: { sessionId: string; type?: string }) => {
            if (event.sessionId !== sessionId || event.type !== "turn_stop") return;
            const elapsed = Date.now() - promptStart;
            const reqCtx = requestContexts.get(sessionId);
            const responseLen = reqCtx?.responseText?.length || 0;
            log.info("Streaming turn complete", {
              sessionId: sid(sessionId),
              elapsed: `${elapsed}ms`,
              responseChars: responseLen,
            });
            agentClient.removeListener("session.event", turnListener);
          };
          agentClient.on("session.event", turnListener);

          return { status: "streaming", sessionId };
        }

        // Non-streaming: await completion, return final text
        const promptStart = Date.now();
        return new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            log.error("Prompt timed out", { sessionId: sid(sessionId), elapsed: "300s" });
            reject(new Error("Prompt timed out after 5 minutes"));
          }, 300_000);

          const onEvent = (event: { eventName: string; sessionId: string; type?: string }) => {
            if (event.sessionId !== sessionId) return;
            if (event.type === "turn_stop") {
              const reqCtx = requestContexts.get(sessionId);
              const text = reqCtx?.responseText || "";
              cleanup();
              const elapsed = Date.now() - promptStart;
              log.info("Non-streaming prompt complete", {
                sessionId: sid(sessionId),
                elapsed: `${elapsed}ms`,
                responseChars: text.length,
              });
              resolve({ text, sessionId });
            }
          };

          const cleanup = () => {
            clearTimeout(timeout);
            agentClient.removeListener("session.event", onEvent);
            requestContexts.delete(sessionId);
            primaryContexts.delete(sessionId);
          };

          agentClient.on("session.event", onEvent);
          agentClient.prompt(sessionId, content, cwd, resumeModel, agent).catch((err) => {
            cleanup();
            reject(err);
          });
        });
      }

      case "session.interrupt_session": {
        log.info("Interrupting session", { sessionId: sid(params.sessionId as string) });
        const ok = await agentClient.interrupt(params.sessionId as string);
        return { ok };
      }

      case "session.close_session": {
        log.info("Closing session", { sessionId: sid(params.sessionId as string) });
        await agentClient.close(params.sessionId as string);
        requestContexts.delete(params.sessionId as string);
        primaryContexts.delete(params.sessionId as string);
        const existing = getStoredSession(params.sessionId as string);
        if (existing) {
          upsertSession({
            id: existing.id,
            workspaceId: existing.workspaceId,
            providerSessionId: existing.providerSessionId,
            model: existing.model,
            agent: existing.agent,
            purpose: existing.purpose,
            parentSessionId: existing.parentSessionId,
            status: "archived",
            runtimeStatus: existing.runtimeStatus,
            title: existing.title,
            summary: existing.summary,
            metadata: existing.metadata,
            previousSessionId: existing.previousSessionId,
          });
        }
        log.info("Session closed", { sessionId: sid(params.sessionId as string) });
        return { ok: true };
      }

      case "session.list_sessions": {
        const cwd = params.cwd as string;
        const workspaceResult = getOrCreateWorkspace(cwd);
        const discovered = discoverSessions(cwd);
        for (const entry of discovered) {
          if (!entry.sessionId) continue;
          upsertSession({
            id: entry.sessionId,
            workspaceId: workspaceResult.workspace.id,
            providerSessionId: entry.sessionId,
            model: sessionConfig.model,
            agent: "claude",
            purpose: "chat",
            runtimeStatus: "idle",
            metadata: {
              messageCount: entry.messageCount,
              firstPrompt: entry.firstPrompt,
              gitBranch: entry.gitBranch,
            },
            lastActivity: entry.modified || entry.created,
          });
        }
        let sessions: Array<{
          sessionId: string;
          created?: string;
          modified?: string;
          messageCount?: number;
          firstPrompt?: string;
          gitBranch?: string;
        }>;
        if (discovered.length > 0) {
          sessions = discovered;
        } else if (workspaceResult.created) {
          sessions = [];
        } else {
          sessions = listWorkspaceSessions(workspaceResult.workspace.id);
        }
        log.info("Listed sessions", { cwd, count: sessions.length });
        return {
          sessions: sessions.sort((a, b) => {
            const aTime = a.modified || a.created || "";
            const bTime = b.modified || b.created || "";
            return bTime.localeCompare(aTime); // Descending by recency
          }),
        };
      }

      case "session.get_history": {
        const sessionId = params.sessionId as string;
        const cwd = params.cwd as string | undefined;
        const limit = (params.limit as number) || 50;
        const offset = (params.offset as number) || 0;

        const filepath = resolveSessionPath(sessionId, cwd);
        if (!filepath) {
          log.warn("Session file not found", { sessionId: sid(sessionId), cwd: cwd || "none" });
          return { messages: [], total: 0, hasMore: false };
        }

        const result = parseSessionFilePaginated(filepath, { limit, offset });
        const usage = parseSessionUsage(filepath);

        log.info("Loaded history", {
          sessionId: sid(sessionId),
          total: (result as { total: number }).total,
          limit,
          offset,
          hasUsage: !!usage,
        });

        return { ...result, usage };
      }

      case "session.switch_session": {
        const sessionId = params.sessionId as string;
        const cwd = params.cwd as string;
        const model = params.model as string | undefined;
        const workspaceResult = getOrCreateWorkspace(cwd);
        const existing = getStoredSession(sessionId);

        // Transition ALL active conversations for this workspace to 'ready' for Libby
        try {
          await withTimeout(
            ctx.call("memory.transition_conversation", { cwd }),
            MEMORY_TRANSITION_TIMEOUT_MS,
            "memory.transition_conversation",
          );
        } catch (err) {
          log.warn("Failed to transition previous conversations (non-fatal)", {
            cwd,
            error: String(err),
          });
        }
        const resumeModel = model || existing?.model || sessionConfig.model;
        const activeSessions = (await agentClient.list()) as AgentHostSessionInfo[];
        const activeSession = activeSessions.find((s) => s.id === sessionId);
        if (
          activeSession &&
          activeSession.isProcessRunning &&
          activeSession.model &&
          resumeModel &&
          activeSession.model !== resumeModel
        ) {
          log.warn("Detected model drift during switch; recycling session runtime", {
            sessionId: sid(sessionId),
            runningModel: activeSession.model,
            desiredModel: resumeModel,
          });
          await agentClient.close(sessionId);
        }

        log.info("Switching session", { sessionId: sid(sessionId), cwd, model: resumeModel });
        // Agent-host handles resume internally via prompt with cwd
        await agentClient.prompt(sessionId, "", cwd, resumeModel);
        upsertSession({
          id: sessionId,
          workspaceId: workspaceResult.workspace.id,
          providerSessionId: existing?.providerSessionId || sessionId,
          model: existing?.model || resumeModel,
          agent: existing?.agent || "claude",
          purpose: existing?.purpose || "chat",
          runtimeStatus: "idle",
          metadata: existing?.metadata || null,
          previousSessionId: existing?.previousSessionId ?? null,
        });
        setWorkspaceActiveSession(workspaceResult.workspace.id, sessionId);
        return { sessionId };
      }

      case "session.reset_session": {
        const cwd = params.cwd as string;
        const model = (params.model as string | undefined) || sessionConfig.model;
        const workspaceResult = getOrCreateWorkspace(cwd);
        const previousSessionId = getWorkspaceActiveSession(workspaceResult.workspace.id);

        // Transition ALL active conversations for this workspace to 'ready' for Libby
        try {
          await withTimeout(
            ctx.call("memory.transition_conversation", { cwd }),
            MEMORY_TRANSITION_TIMEOUT_MS,
            "memory.transition_conversation",
          );
        } catch (err) {
          log.warn("Failed to transition previous conversations (non-fatal)", {
            cwd,
            error: String(err),
          });
        }

        log.info("Resetting session", { cwd });
        const result = await agentClient.createSession({
          cwd,
          model,
        });
        upsertSession({
          id: result.sessionId,
          workspaceId: workspaceResult.workspace.id,
          providerSessionId: result.sessionId,
          model,
          agent: "claude",
          purpose: "chat",
          runtimeStatus: "idle",
          previousSessionId,
        });
        setWorkspaceActiveSession(workspaceResult.workspace.id, result.sessionId);
        return result;
      }

      case "session.get_info": {
        const sessionId = params.sessionId as string | undefined;
        const activeSessions = (await agentClient.list()) as Array<{ id: string }>;

        if (sessionId) {
          const session = activeSessions.find((s) => s.id === sessionId);
          return { session: session || null, activeSessions };
        }

        return { activeSessions };
      }

      case "session.set_permission_mode": {
        log.info("Setting permission mode", {
          sessionId: sid(params.sessionId as string),
          mode: params.mode,
        });
        const ok = await agentClient.setPermissionMode(
          params.sessionId as string,
          params.mode as string,
        );
        return { ok };
      }

      case "session.send_tool_result": {
        log.info("Sending tool result", {
          sessionId: sid(params.sessionId as string),
          toolUseId: params.toolUseId,
          isError: params.isError,
        });
        const ok = await agentClient.sendToolResult(
          params.sessionId as string,
          params.toolUseId as string,
          params.content as string,
          params.isError as boolean,
        );
        return { ok };
      }

      case "session.start_task": {
        const sessionId = params.sessionId as string;
        const agent = params.agent as string;
        const prompt = params.prompt as string;
        const mode = normalizeTaskMode(params.mode as string | undefined);
        const cwd = params.cwd as string | undefined;
        const worktree = params.worktree as boolean | undefined;
        const continueTaskId = params.continue as string | undefined;
        const model = params.model as string | undefined;
        const effort = params.effort as string | undefined;
        const sandbox = params.sandbox as "read-only" | "workspace-write" | "danger-full-access";
        const files = params.files as string[] | undefined;
        const parentSession = getStoredSession(sessionId);

        // If task cwd is omitted, inherit from parent session context.
        let effectiveCwd = cwd;
        if (!effectiveCwd && parentSession?.workspaceId) {
          const workspace = getWorkspace(parentSession.workspaceId);
          effectiveCwd = workspace?.cwd;
        }
        if (!effectiveCwd) {
          const activeSessions = (await agentClient.list()) as AgentHostSessionInfo[];
          effectiveCwd = activeSessions.find((s) => s.id === sessionId)?.cwd;
        }

        const result = (await agentClient.startTask({
          sessionId,
          agent,
          prompt,
          mode,
          cwd: effectiveCwd,
          worktree,
          continue: continueTaskId,
          model,
          effort,
          sandbox,
          files,
          metadata: params.metadata as Record<string, unknown> | undefined,
        })) as {
          taskId: string;
          outputFile?: string;
          status?: string;
          message?: string;
          cwd?: string;
          worktreePath?: string;
          parentRepoPath?: string;
          continuedFromTaskId?: string;
        };

        const nowIso = new Date().toISOString();
        const workspaceId =
          parentSession?.workspaceId ||
          (effectiveCwd ? getOrCreateWorkspace(effectiveCwd).workspace.id : null);
        if (!workspaceId) {
          throw new Error(`Unable to resolve workspace for parent session ${sessionId}`);
        }
        const task: SessionTask = {
          taskId: result.taskId,
          sessionId,
          agent,
          cwd: result.cwd || effectiveCwd,
          worktreePath: result.worktreePath,
          parentRepoPath: result.parentRepoPath,
          continuedFromTaskId: result.continuedFromTaskId,
          prompt,
          mode,
          status: "running",
          startedAt: nowIso,
          updatedAt: nowIso,
          outputFile: result.outputFile,
          context: {
            connectionId: ctx.connectionId,
            tags: ctx.tags,
          },
        };
        tasks.set(task.taskId, task);
        taskNotificationsSent.delete(task.taskId);
        upsertSession({
          id: task.taskId,
          workspaceId,
          providerSessionId: task.taskId,
          model: model || parentSession?.model || sessionConfig.model,
          agent: task.agent,
          purpose: task.mode === "review" || task.mode === "test" ? task.mode : "task",
          parentSessionId: task.sessionId,
          runtimeStatus: "running",
          metadata: {
            prompt: task.prompt,
            cwd: task.cwd,
            worktreePath: task.worktreePath,
            parentRepoPath: task.parentRepoPath,
            continuedFromTaskId: task.continuedFromTaskId,
            outputFile: task.outputFile,
            connectionId: task.context.connectionId,
            tags: task.context.tags,
          },
          lastActivity: nowIso,
        });

        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          agent: task.agent,
          mode: task.mode,
          status: task.status,
          cwd: task.cwd,
          worktreePath: task.worktreePath,
          parentRepoPath: task.parentRepoPath,
          continuedFromTaskId: task.continuedFromTaskId,
          outputFile: task.outputFile,
          message: result.message || `Started ${agent} task`,
        };
      }

      case "session.get_task": {
        const result = (await agentClient.getTask(params.taskId as string)) as {
          task?: SessionTask | null;
        };
        const hostTask = (result?.task || null) as SessionTask | null;
        if (hostTask) {
          tasks.set(hostTask.taskId, hostTask);
        }
        const storedTask = toSessionTaskFromStored(getStoredSession(params.taskId as string));
        return { task: hostTask || storedTask || null };
      }

      case "session.list_tasks": {
        const result = (await agentClient.listTasks({
          sessionId: params.sessionId as string | undefined,
          status: params.status as TaskStatus | undefined,
          agent: params.agent as string | undefined,
        })) as { tasks?: SessionTask[] };
        const hostTasks = result.tasks || [];
        for (const task of hostTasks) {
          tasks.set(task.taskId, task);
          const taskStored = getStoredSession(task.taskId);
          const parentStored = getStoredSession(task.sessionId);
          const workspaceId = taskStored?.workspaceId || parentStored?.workspaceId;
          if (workspaceId) {
            upsertSession({
              id: task.taskId,
              workspaceId,
              providerSessionId: task.taskId,
              model: taskStored?.model || parentStored?.model || sessionConfig.model,
              agent: task.agent,
              purpose: task.mode === "review" || task.mode === "test" ? task.mode : "task",
              parentSessionId: task.sessionId,
              runtimeStatus: task.status === "running" ? "running" : task.status,
              metadata: {
                prompt: task.prompt,
                cwd: task.cwd,
                worktreePath: task.worktreePath,
                parentRepoPath: task.parentRepoPath,
                continuedFromTaskId: task.continuedFromTaskId,
                git: task.git,
                outputFile: task.outputFile,
                error: task.error,
                connectionId: task.context?.connectionId || null,
                tags: task.context?.tags || null,
              },
            });
          }
        }
        const stored = listTaskSessions({
          parentSessionId: params.sessionId as string | undefined,
          status: params.status as TaskStatus | undefined,
          agent: params.agent as string | undefined,
        })
          .map((row) => toSessionTaskFromStored(row))
          .filter((row): row is SessionTask => !!row);

        const merged = new Map<string, SessionTask>();
        for (const task of stored) merged.set(task.taskId, task);
        for (const task of hostTasks) merged.set(task.taskId, task);
        const hydrated = Array.from(merged.values()).map((task) => {
          if (!task.cwd) return task;
          const git = getTaskGitInfo(task.cwd, task.parentRepoPath, task.worktreePath);
          return git ? { ...task, git } : task;
        });
        return { tasks: hydrated };
      }

      case "session.interrupt_task": {
        const taskId = params.taskId as string;
        const task = tasks.get(taskId) || toSessionTaskFromStored(getStoredSession(taskId));
        if (!task) {
          return { ok: false, error: "Task not found", taskId };
        }
        const ok = await agentClient.interruptTask(taskId);
        if (ok) {
          task.status = "interrupted";
          task.updatedAt = new Date().toISOString();
          const stored = getStoredSession(taskId);
          if (stored) {
            upsertSession({
              id: stored.id,
              workspaceId: stored.workspaceId,
              providerSessionId: stored.providerSessionId,
              model: stored.model,
              agent: stored.agent,
              purpose: stored.purpose,
              parentSessionId: stored.parentSessionId,
              runtimeStatus: "interrupted",
              status: stored.status,
              title: stored.title,
              summary: stored.summary,
              metadata: { ...(stored.metadata || {}), interruptedAt: task.updatedAt },
              previousSessionId: stored.previousSessionId,
            });
          }
        }
        return { ok, taskId };
      }

      case "session.send_notification": {
        const sessionId = params.sessionId as string;
        const text = params.text as string;

        log.info("Sending notification", { sessionId: sid(sessionId), text: truncate(text) });

        await sendSessionNotification(sessionId, text, {
          connectionId: ctx.connectionId,
          tags: ctx.tags,
        });

        return { ok: true, sessionId };
      }

      case "session.list_workspaces": {
        return { workspaces: listWorkspaces() };
      }

      case "session.get_workspace": {
        const workspace = getWorkspace(params.id as string);
        return { workspace };
      }

      case "session.get_or_create_workspace": {
        const cwd = params.cwd as string;
        const result = getOrCreateWorkspace(
          cwd,
          params.name as string | undefined,
          params.general as boolean | undefined,
        );
        log.info("Get/create workspace", {
          cwd,
          created: (result as { created: boolean }).created,
          general: result.workspace.general,
        });
        return result;
      }

      case "session.delete_workspace": {
        const cwd = params.cwd as string;
        const deleted = deleteWorkspace(cwd);
        return { deleted };
      }

      case "session.get_directories": {
        const path = (params.path as string | undefined) || "~";
        const directories = getDirectories(path);
        return { path, directories };
      }

      case "session.health_check": {
        return healthCheckDetailed();
      }

      case "session.rotate_persistent_sessions": {
        const rotationConfig = (config.persistentSessionRotation as {
          maxMessages?: number;
          maxAgeHours?: number;
        }) || { maxMessages: 200, maxAgeHours: 24 };
        const maxMessages = rotationConfig.maxMessages ?? 200;
        const maxAgeHours = rotationConfig.maxAgeHours ?? 24;
        return rotatePersistentSessions({
          store: {
            getEntries: () =>
              ctx.store.get<
                Record<string, { sessionId: string; messageCount: number; createdAt: string }>
              >("persistentSessions") || {},
            setEntries: (entries) => {
              ctx.store.set("persistentSessions", entries);
            },
          },
          maxMessages,
          maxAgeHours,
          log,
          formatSessionId: sid,
        });
      }

      case "session.get_memory_context": {
        const cwd = (params.cwd as string | undefined) || process.cwd();
        const workspace = getWorkspaceByCwd(cwd);

        try {
          const memoryContext = (await ctx.call("memory.get_session_context", {
            cwd,
            includeAllSummaries: workspace?.general === true,
          })) as MemoryContextResult | null;

          if (!memoryContext) {
            return { formatted: null, raw: null, note: "No memory context available" };
          }

          const formatted = formatMemoryContext(memoryContext);
          return {
            formatted,
            raw: memoryContext,
            formattedLength: formatted?.length || 0,
          };
        } catch (err) {
          return { formatted: null, raw: null, error: String(err) };
        }
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ── Health Check ───────────────────────────────────────────

  function health(): HealthCheckResponse {
    const agentHostConnected = agentClient.isConnected;
    return {
      ok: true,
      status: agentHostConnected ? "healthy" : "degraded",
      label: "Sessions",
      metrics: [{ label: "Agent Host", value: agentHostConnected ? "connected" : "disconnected" }],
      actions: [],
      items: [],
    };
  }

  function formatElapsed(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "n/a";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }

  async function healthCheckDetailed(): Promise<HealthCheckResponse> {
    const agentHostConnected = agentClient.isConnected;
    if (!agentHostConnected) {
      return {
        ok: false,
        status: "degraded",
        label: "Sessions",
        metrics: [{ label: "Agent Host", value: "disconnected" }],
        actions: [],
        items: [],
      };
    }

    let sessions: AgentHostSessionInfo[] = [];
    try {
      sessions = (await agentClient.list()) as AgentHostSessionInfo[];
    } catch {
      return {
        ok: false,
        status: "degraded",
        label: "Sessions",
        metrics: [
          { label: "Agent Host", value: "connected" },
          { label: "Sessions", value: "unavailable" },
        ],
        actions: [],
        items: [],
      };
    }

    const visibleSessions = sessions.filter((s) => s.isProcessRunning);
    const activeCount = visibleSessions.filter((s) => s.isActive).length;
    const runningCount = visibleSessions.length;
    const staleCount = visibleSessions.filter((s) => s.stale).length;
    const sortedSessions = [...visibleSessions].sort((a, b) => {
      const aTs = Date.parse(a.lastActivity || "");
      const bTs = Date.parse(b.lastActivity || "");
      const safeA = Number.isFinite(aTs) ? aTs : 0;
      const safeB = Number.isFinite(bTs) ? bTs : 0;
      return safeB - safeA;
    });

    return {
      ok: true,
      status: "healthy",
      label: "Sessions",
      metrics: [
        { label: "Agent Host", value: "connected" },
        { label: "Active Sessions", value: activeCount },
        { label: "Running SDK", value: runningCount },
        { label: "Stale", value: staleCount },
      ],
      actions: [],
      items: sortedSessions.map((session) => ({
        id: session.id,
        label: session.cwd || session.id,
        status: !session.isActive ? "inactive" : session.stale ? "stale" : "healthy",
        details: {
          model: session.model || "unknown",
          running: session.isProcessRunning ? "yes" : "no",
          lastActivity: session.lastActivity || "n/a",
          lastActivityAgo: formatElapsed(Date.now() - Date.parse(session.lastActivity)),
        },
      })),
    };
  }

  // ── Extension Interface ────────────────────────────────────

  return {
    id: "session",
    name: "Session Manager",
    methods,
    events: ["stream.*", "session.task.*"],
    sourceRoutes: [],

    async start(extCtx: ExtensionContext): Promise<void> {
      ctx = extCtx;
      wireTaskEventBridge();
      try {
        await agentClient.connect();
        const activeSessions = (await agentClient.list()) as AgentHostSessionInfo[];
        for (const session of activeSessions) {
          if (!session.cwd) continue;
          const workspaceResult = getOrCreateWorkspace(session.cwd);
          const runtimeStatus: RuntimeStatus = session.isProcessRunning
            ? session.stale
              ? "stalled"
              : "running"
            : "idle";
          upsertSession({
            id: session.id,
            workspaceId: workspaceResult.workspace.id,
            providerSessionId: session.id,
            model: session.model,
            agent: "claude",
            purpose: "chat",
            runtimeStatus,
            lastActivity: session.lastActivity,
          });
          if (session.isActive) {
            setWorkspaceActiveSession(workspaceResult.workspace.id, session.id);
          }
        }
        log.info("Session extension started 🚀", { url: agentHostConfig.url });
      } catch (error) {
        log.warn("Failed to connect to agent-host, will retry in background", {
          error: String(error),
        });
      }
    },

    async stop(): Promise<void> {
      for (const unsub of taskUnsubscribers) {
        try {
          unsub();
        } catch {
          // ignore cleanup failures
        }
      }
      taskUnsubscribers.length = 0;
      tasks.clear();
      agentClient.disconnect();
      closeSessionDb();
      closeDb();
      log.info("Session extension stopped");
    },

    handleMethod,

    health,
  };
}

export default createSessionExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createSessionExtension);
