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
  ClaudiaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  HealthCheckResponse,
} from "@claudia/shared";
import { createLogger, loadConfig } from "@claudia/shared";
import type { SessionConfig } from "@claudia/shared";
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
  getOrCreateWorkspace,
  deleteWorkspace,
  closeDb,
} from "./workspace";

const log = createLogger("SessionExt", join(homedir(), ".claudia", "logs", "session.log"));

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
            (b: { type: string; text?: string }) => b.type === "text" && b.text,
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

// ── Request context tracking ─────────────────────────────────

interface RequestContext {
  connectionId: string | null;
  tags: string[] | null;
  source?: string;
  responseText: string;
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

// ── Extension factory ────────────────────────────────────────

export function createSessionExtension(config: Record<string, unknown> = {}): ClaudiaExtension {
  let ctx: ExtensionContext;

  // Load global configuration (claudia.json + defaults)
  const globalConfig = loadConfig();
  const sessionConfig = globalConfig.session;
  const agentHostConfig = globalConfig.agentHost;

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

  // Wire agent-host events → ctx.emit
  agentClient.on(
    "session.event",
    (event: { eventName: string; sessionId: string; [key: string]: unknown }) => {
      if (!ctx) return;

      const { eventName, sessionId, ...payload } = event;
      const reqCtx = requestContexts.get(sessionId);
      const primaryCtx = primaryContexts.get(sessionId);

      // Log streaming events for debugging (Michael requested this)
      const shortSessionId = sessionId.slice(0, 8);
      const eventSize = JSON.stringify(payload).length;
      log.info(`[Stream] ${eventName} → session.${shortSessionId} (${eventSize}b)`, {
        eventName,
        sessionId: shortSessionId,
        payloadKeys: Object.keys(payload),
      });

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

      // Accumulate response text for non-streaming callers
      if (payload.type === "content_block_delta") {
        const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
        if (delta?.type === "text_delta" && delta.text && reqCtx) {
          reqCtx.responseText += delta.text;
        }
      }
    },
  );

  // ── Method Definitions ─────────────────────────────────────

  const methods: ExtensionMethodDefinition[] = [
    {
      name: "session.create_session",
      description: "Create a new Claude session for a workspace CWD",
      inputSchema: z.object({
        cwd: z.string().describe("Working directory"),
        model: z.string().optional().describe("Model to use"),
        systemPrompt: z.string().optional().describe("System prompt"),
        thinking: z.boolean().optional().describe("Enable thinking"),
        effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Thinking effort"),
      }),
    },
    {
      name: "session.send_prompt",
      description: "Send a prompt to a session (streaming or await completion)",
      inputSchema: z.object({
        sessionId: z.string().describe("Session UUID"),
        content: z.union([z.string(), z.array(z.unknown())]).describe("Prompt content"),
        cwd: z.string().optional().describe("CWD for auto-resume"),
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
      description: "List sessions for a workspace (reads sessions-index.json)",
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
        "Used by extensions (e.g. codex) to notify the session when async work completes.",
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
      method === "session.health_check";
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
        const model = (params.model as string | undefined) || sessionConfig.model;
        const thinking = (params.thinking as boolean | undefined) ?? sessionConfig.thinking;
        const effort =
          (params.effort as "low" | "medium" | "high" | "max" | undefined) || sessionConfig.effort;
        const systemPrompt =
          (params.systemPrompt as string | undefined) || sessionConfig.systemPrompt || undefined;

        log.info("Creating session", {
          cwd,
          model,
          thinking,
          effort,
        });
        const result = await agentClient.createSession({
          cwd,
          model,
          systemPrompt,
          thinking,
          effort,
        });
        log.info("Session created", { sessionId: sid(result.sessionId), cwd });
        return result;
      }

      case "session.send_prompt": {
        const sessionId = params.sessionId as string;
        const content = params.content as string | unknown[];
        const cwd = params.cwd as string | undefined;
        const streaming = params.streaming !== false;
        const source = params.source as string | undefined;

        log.info("Sending prompt", {
          sessionId: sid(sessionId),
          streaming,
          source: source || "web",
          prompt: truncate(content),
        });

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
          await agentClient.prompt(sessionId, content, cwd);

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
          agentClient.prompt(sessionId, content, cwd).catch((err) => {
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
        log.info("Session closed", { sessionId: sid(params.sessionId as string) });
        return { ok: true };
      }

      case "session.list_sessions": {
        const cwd = params.cwd as string;
        const sessions = discoverSessions(cwd);
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

        log.info("Switching session", { sessionId: sid(sessionId), cwd, model });
        // Agent-host handles resume internally via prompt with cwd
        await agentClient.prompt(sessionId, "", cwd);
        return { sessionId };
      }

      case "session.reset_session": {
        const cwd = params.cwd as string;
        log.info("Resetting session", { cwd });
        const result = await agentClient.createSession({
          cwd,
          model: params.model as string | undefined,
        });
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

      case "session.send_notification": {
        const sessionId = params.sessionId as string;
        const text = params.text as string;

        log.info("Sending notification", { sessionId: sid(sessionId), text: truncate(text) });

        // Set up request context so the session's response streams to the right connection.
        // Don't clobber the primary context — notifications are transient.
        const notifCtx: RequestContext = {
          connectionId: ctx.connectionId,
          tags: ctx.tags,
          responseText: "",
        };
        requestContexts.set(sessionId, notifCtx);
        // primaryContexts is NOT modified — voice tags persist through notifications

        const wrapped = `<user_notification>\n${text}\n</user_notification>`;
        await agentClient.prompt(sessionId, wrapped);

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
        const result = getOrCreateWorkspace(cwd, params.name as string | undefined);
        log.info("Get/create workspace", {
          cwd,
          created: (result as { created: boolean }).created,
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

    const activeCount = sessions.filter((s) => s.isActive).length;
    const runningCount = sessions.filter((s) => s.isProcessRunning).length;
    const staleCount = sessions.filter((s) => s.stale).length;

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
      items: sessions.map((session) => ({
        id: session.id,
        label: session.cwd || session.id,
        status: !session.isActive ? "inactive" : session.stale ? "stale" : "healthy",
        details: {
          model: session.model || "unknown",
          running: session.isProcessRunning ? "yes" : "no",
          lastActivity: session.lastActivity || "n/a",
        },
      })),
    };
  }

  // ── Extension Interface ────────────────────────────────────

  return {
    id: "session",
    name: "Session Manager",
    methods,
    events: ["stream.*"],
    sourceRoutes: [],

    async start(extCtx: ExtensionContext): Promise<void> {
      ctx = extCtx;
      try {
        await agentClient.connect();
        log.info("Session extension started 🚀", { url: agentHostConfig.url });
      } catch (error) {
        log.warn("Failed to connect to agent-host, will retry in background", {
          error: String(error),
        });
      }
    },

    async stop(): Promise<void> {
      agentClient.disconnect();
      closeDb();
      log.info("Session extension stopped");
    },

    handleMethod,

    health,
  };
}

export default createSessionExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createSessionExtension);
