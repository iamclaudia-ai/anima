import { createLogger, loadConfig } from "@claudia/shared";
import type {
  ClaudiaConfig,
  AgentHostClientMessage as ClientMessage,
  AgentHostResponseMessage as ResponseMessage,
  AgentHostSessionEventMessage as SessionEventMessage,
  AgentHostTaskEventMessage as TaskEventMessage,
} from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  SessionHost,
  type SessionCreateParams,
  type SessionDefaults,
  type SessionRecord,
  type SessionResumeParams,
} from "./session-host";
import { loadState, saveState, type PersistedState } from "./state";
import { restorePersistedSessions } from "./restore";
import type { BufferedEvent } from "./event-buffer";
import type { ThinkingEffort } from "@claudia/shared";
import { TaskHost, type TaskRecord } from "./task-host";

export interface SessionHostLike {
  on: (eventName: "session.event", listener: (msg: SessionEventMessage) => void) => unknown;
  setDefaults: (defaults: SessionDefaults) => void;
  create: (params: SessionCreateParams) => Promise<{ sessionId: string }>;
  resume: (params: SessionResumeParams) => Promise<{ sessionId: string }>;
  prompt: (
    sessionId: string,
    content: string | unknown[],
    cwd?: string,
    agent?: string,
  ) => Promise<void> | void;
  interrupt: (sessionId: string) => boolean;
  close: (sessionId: string) => Promise<void>;
  setPermissionMode: (sessionId: string, mode: string) => boolean;
  sendToolResult: (
    sessionId: string,
    toolUseId: string,
    content: string,
    isError?: boolean,
  ) => boolean;
  list: () => Array<unknown>;
  getSessionRecords: () => SessionRecord[];
  getEventsAfter: (sessionId: string, lastSeq: number) => BufferedEvent[];
  closeAll: () => Promise<void>;
  reapIdleRunningSessions?: (idleMs: number, nowMs?: number) => Promise<string[]>;
}

export interface TaskHostLike {
  on: (eventName: "task.event", listener: (msg: TaskEventMessage) => void) => unknown;
  start: (params: {
    sessionId: string;
    agent: string;
    prompt: string;
    mode?: string;
    cwd?: string;
    model?: string;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    files?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<{ taskId: string; status: string; outputFile?: string; message: string }>;
  get: (taskId: string) => TaskRecord | null;
  list: (filters?: { sessionId?: string; status?: string; agent?: string }) => TaskRecord[];
  interrupt: (taskId: string) => boolean;
  getEventsAfter: (taskId: string, lastSeq: number) => BufferedEvent[];
}

export interface AgentHostServerOptions {
  port?: number;
  sessionHost?: SessionHostLike;
  loadConfig?: typeof loadConfig;
  loadState?: () => PersistedState;
  saveState?: typeof saveState;
  logger?: ReturnType<typeof createLogger>;
  stateSaveIntervalMs?: number | null;
  taskHost?: TaskHostLike;
}

export interface AgentHostServerContext {
  server: ReturnType<typeof Bun.serve>;
  sessionHost: SessionHostLike;
  taskHost: TaskHostLike;
  clients: Map<unknown, WSClient>;
  handleMessage: (ws: unknown, raw: string) => Promise<void>;
  broadcastSessionEvent: (msg: SessionEventMessage) => void;
  broadcastTaskEvent: (msg: TaskEventMessage) => void;
  stop: (signal?: string) => Promise<void>;
  port: number;
}

interface WSClient {
  ws: unknown; // Bun's ServerWebSocket type
  extensionId: string;
  subscribedSessions: Set<string>;
  subscribedTasks: Set<string>;
}

export async function createAgentHostServer(
  options: AgentHostServerOptions = {},
): Promise<AgentHostServerContext> {
  const port = options.port ?? 30087;
  const log =
    options.logger ??
    createLogger("AgentHost", join(homedir(), ".claudia", "logs", "agent-host.log"));
  const sessionHost = options.sessionHost ?? new SessionHost();
  const loadConfigFn = options.loadConfig ?? loadConfig;
  const loadStateFn = options.loadState ?? loadState;
  const saveStateFn = options.saveState ?? saveState;
  const stateSaveIntervalMs = options.stateSaveIntervalMs ?? 30_000;
  let loadedConfig: ClaudiaConfig | null = null;

  // Load config for session defaults
  try {
    const config = loadConfigFn();
    loadedConfig = config;
    sessionHost.setDefaults({
      model: config.session?.model,
      thinking: config.session?.thinking,
      effort: config.session?.effort,
    });
    log.info("Loaded config", {
      model: config.session?.model,
      thinking: config.session?.thinking,
      effort: config.session?.effort,
    });
  } catch (error) {
    log.warn("Failed to load config, using defaults", { error: String(error) });
  }

  const taskHost =
    options.taskHost ??
    new TaskHost({
      codex: loadedConfig?.agentHost?.codex,
    });

  // Load persisted session registry (for crash recovery)
  const persistedState = loadStateFn();
  log.info("Persisted state loaded", { sessions: persistedState.sessions.length });

  // Restore sessions to memory
  await restorePersistedSessions(sessionHost, persistedState, log);

  // ── WebSocket Client Tracking ──────────────────────────────
  const clients = new Map<unknown, WSClient>();

  /**
   * Broadcast a session event to all clients subscribed to that session.
   */
  function broadcastSessionEvent(msg: SessionEventMessage): void {
    const data = JSON.stringify(msg);
    for (const [, client] of clients) {
      if (client.subscribedSessions.has(msg.sessionId)) {
        try {
          (client.ws as { send(data: string): void }).send(data);
        } catch (error) {
          log.warn("Failed to send to client", {
            extensionId: client.extensionId,
            error: String(error),
          });
        }
      }
    }
  }

  function broadcastTaskEvent(msg: TaskEventMessage): void {
    const data = JSON.stringify(msg);
    for (const [, client] of clients) {
      if (client.subscribedTasks.has(msg.taskId)) {
        try {
          (client.ws as { send(data: string): void }).send(data);
        } catch (error) {
          log.warn("Failed to send task event to client", {
            extensionId: client.extensionId,
            error: String(error),
          });
        }
      }
    }
  }

  /**
   * Send a response to a specific WebSocket client.
   */
  function sendResponse(ws: unknown, res: ResponseMessage): void {
    try {
      (ws as { send(data: string): void }).send(JSON.stringify(res));
    } catch (error) {
      log.warn("Failed to send response", { error: String(error) });
    }
  }

  // ── Wire SessionHost events → WebSocket broadcast ──────────
  sessionHost.on("session.event", (msg: SessionEventMessage) => {
    broadcastSessionEvent(msg);
  });
  taskHost.on("task.event", (msg: TaskEventMessage) => {
    broadcastTaskEvent(msg);
  });

  // ── Message Handler ────────────────────────────────────────
  async function handleMessage(ws: unknown, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      log.warn("Invalid JSON from client", { raw: raw.slice(0, 100) });
      return;
    }

    switch (msg.type) {
      case "auth": {
        const client: WSClient = {
          ws,
          extensionId: msg.extensionId,
          subscribedSessions: new Set(),
          subscribedTasks: new Set(),
        };
        clients.set(ws, client);
        log.info("Client authenticated", { extensionId: msg.extensionId });

        // Handle reconnection — replay buffered events for resumed sessions
        if (msg.resumeSessions) {
          for (const { sessionId, lastSeq } of msg.resumeSessions) {
            client.subscribedSessions.add(sessionId);
            const missed = sessionHost.getEventsAfter(sessionId, lastSeq);
            log.info("Replaying missed events", {
              sessionId: sessionId.slice(0, 8),
              lastSeq,
              count: missed.length,
            });
            for (const buffered of missed) {
              const replayMsg: SessionEventMessage = {
                type: "session.event",
                sessionId,
                event: buffered.event as { type: string; [key: string]: unknown },
                seq: buffered.seq,
              };
              sendResponse(ws, replayMsg as unknown as ResponseMessage);
            }
          }
        }
        if (msg.resumeTasks) {
          for (const { taskId, lastSeq } of msg.resumeTasks) {
            client.subscribedTasks.add(taskId);
            const missed = taskHost.getEventsAfter(taskId, lastSeq);
            for (const buffered of missed) {
              const replayMsg: TaskEventMessage = {
                type: "task.event",
                taskId,
                event: buffered.event as { type: string; [key: string]: unknown },
                seq: buffered.seq,
              };
              sendResponse(ws, replayMsg as unknown as ResponseMessage);
            }
          }
        }
        break;
      }

      case "session.create": {
        try {
          const result = await sessionHost.create(
            msg.params as {
              cwd: string;
              agent?: string;
              model?: string;
              systemPrompt?: string;
              thinking?: boolean;
              effort?: ThinkingEffort;
            },
          );

          // Auto-subscribe the creating client to this session
          const client = clients.get(ws);
          if (client) {
            client.subscribedSessions.add(result.sessionId);
          }

          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
            payload: result,
          });

          // Persist state
          saveStateFn(sessionHost.getSessionRecords());
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "session.prompt": {
        try {
          // Auto-subscribe to the session being prompted
          const client = clients.get(ws);
          if (client) {
            client.subscribedSessions.add(msg.sessionId);
          }

          await sessionHost.prompt(msg.sessionId, msg.content, msg.cwd, msg.agent);
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
          });
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "session.interrupt": {
        const ok = sessionHost.interrupt(msg.sessionId);
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok,
          ...(ok ? {} : { error: "Session not found" }),
        });
        break;
      }

      case "session.close": {
        try {
          await sessionHost.close(msg.sessionId);

          // Remove subscription from all clients
          for (const [, client] of clients) {
            client.subscribedSessions.delete(msg.sessionId);
          }

          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
          });

          // Persist state
          saveStateFn(sessionHost.getSessionRecords());
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "task.start": {
        try {
          const result = await taskHost.start(msg.params);
          const client = clients.get(ws);
          if (client) {
            client.subscribedTasks.add(result.taskId);
          }
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
            payload: result,
          });
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "task.get": {
        const task = taskHost.get(msg.taskId);
        const client = clients.get(ws);
        if (client && task) {
          client.subscribedTasks.add(task.taskId);
        }
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok: true,
          payload: { task },
        });
        break;
      }

      case "task.list": {
        const tasks = taskHost.list({
          sessionId: msg.sessionId,
          status: msg.status,
          agent: msg.agent,
        });
        const client = clients.get(ws);
        if (client) {
          for (const task of tasks) {
            client.subscribedTasks.add(task.taskId);
          }
        }
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok: true,
          payload: { tasks },
        });
        break;
      }

      case "task.interrupt": {
        const ok = taskHost.interrupt(msg.taskId);
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok,
          ...(ok ? {} : { error: "Task not found or not running" }),
        });
        break;
      }

      case "session.set_permission_mode": {
        const ok = sessionHost.setPermissionMode(msg.sessionId, msg.mode);
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok,
          ...(ok ? {} : { error: "Session not found" }),
        });
        break;
      }

      case "session.send_tool_result": {
        const ok = sessionHost.sendToolResult(
          msg.sessionId,
          msg.toolUseId,
          msg.content,
          msg.isError,
        );
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok,
          ...(ok ? {} : { error: "Session not found" }),
        });
        break;
      }

      case "session.list": {
        const sessions = sessionHost.list();
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok: true,
          payload: sessions,
        });
        break;
      }

      default: {
        log.warn("Unknown message type", { type: (msg as { type: string }).type });
        break;
      }
    }
  }

  // ── Bun Server ─────────────────────────────────────────────
  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        const sessions = sessionHost.list();
        const tasks = taskHost.list();
        return Response.json({
          ok: true,
          uptime: process.uptime(),
          sessions: sessions.length,
          tasks: tasks.length,
          clients: clients.size,
        });
      }

      if (url.pathname === "/ws") {
        const success = server.upgrade(req);
        if (!success) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open() {
        log.info("WebSocket client connected");
      },
      async message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        await handleMessage(ws, raw);
      },
      close(ws) {
        const client = clients.get(ws);
        if (client) {
          log.info("WebSocket client disconnected", { extensionId: client.extensionId });
          clients.delete(ws);
        }
      },
    },
  });

  log.info(`Agent Host server listening on port ${port}`);

  // ── Periodic State Persistence ─────────────────────────────
  const stateSaveTimer =
    stateSaveIntervalMs === null
      ? null
      : setInterval(() => {
          const records = sessionHost.getSessionRecords();
          if (records.length > 0) {
            saveStateFn(records);
          }
        }, stateSaveIntervalMs);

  async function stop(signal?: string): Promise<void> {
    if (signal) {
      log.info(`Received ${signal}, shutting down...`);
    }

    if (stateSaveTimer) {
      clearInterval(stateSaveTimer);
    }

    saveStateFn(sessionHost.getSessionRecords());
    await sessionHost.closeAll();
    server.stop();

    if (signal) {
      log.info("Agent Host shut down cleanly");
    }
  }

  return {
    server,
    sessionHost,
    taskHost,
    clients,
    handleMessage,
    broadcastSessionEvent,
    broadcastTaskEvent,
    stop,
    port,
  };
}
