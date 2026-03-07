#!/usr/bin/env bun
/**
 * Agent Host Server
 *
 * Standalone Bun server that owns SDK processes (Claude query(), Codex Thread).
 * Extensions connect via WebSocket to send commands and receive streaming events.
 *
 * Key properties:
 * - No dependency on the gateway — runs as a sibling process under watchdog
 * - Uses `bun run` (NOT --watch or --hot) for maximum stability
 * - SDK processes survive gateway/extension restarts
 * - Event buffering enables reconnection replay
 *
 * Port: 30087
 * Health: GET /health
 * WebSocket: /ws
 */

import { createLogger, loadConfig } from "@claudia/shared";
import type {
  AgentHostClientMessage as ClientMessage,
  AgentHostResponseMessage as ResponseMessage,
  AgentHostSessionEventMessage as SessionEventMessage,
} from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { SessionHost } from "./session-host";
import { loadState, saveState } from "./state";
import { restorePersistedSessions } from "./restore";

const log = createLogger("AgentHost", join(homedir(), ".claudia", "logs", "agent-host.log"));

// ── Configuration ────────────────────────────────────────────

const PORT = 30087;
const FORCE_STARTUP = process.argv.includes("--force");

function forceClearGatewayLocks(): void {
  if (!FORCE_STARTUP) return;

  const dbPath = join(homedir(), ".claudia", "claudia.db");
  if (!existsSync(dbPath)) {
    log.warn("Force startup requested, but gateway DB does not exist yet", { dbPath });
    return;
  }

  const db = new Database(dbPath);
  const clear = (tableName: string): number => {
    const exists = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName);
    if (!exists) return 0;
    const result = db.query(`DELETE FROM ${tableName}`).run();
    return result.changes;
  };

  try {
    const cleared = {
      extensionProcessLocks: clear("extension_process_locks"),
      memoryExtensionLocks: clear("memory_extension_locks"),
      memoryFileLocks: clear("memory_file_locks"),
    };
    log.warn("Force startup requested; cleared gateway lock tables", cleared);
  } catch (error) {
    log.error("Failed to clear gateway lock tables during force startup", {
      error: String(error),
    });
  } finally {
    db.close();
  }
}

function parseMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

const IDLE_REAP_INTERVAL_MS = parseMs(process.env.CLAUDIA_AGENT_IDLE_REAP_INTERVAL_MS, 60000);
const IDLE_STALE_MS = parseMs(process.env.CLAUDIA_AGENT_IDLE_STALE_MS, 600000);

forceClearGatewayLocks();

// ── State ────────────────────────────────────────────────────

const sessionHost = new SessionHost();

// Load config for session defaults
try {
  const config = loadConfig();
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

// Load persisted session registry (for crash recovery)
const persistedState = loadState();
log.info("Persisted state loaded", { sessions: persistedState.sessions.length });
await restorePersistedSessions(sessionHost, persistedState, log);

// ── WebSocket Client Tracking ────────────────────────────────

interface WSClient {
  ws: unknown; // Bun's ServerWebSocket type
  extensionId: string;
  /** Sessions this client is subscribed to */
  subscribedSessions: Set<string>;
}

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

// ── Wire SessionHost events → WebSocket broadcast ────────────

sessionHost.on("session.event", (msg: SessionEventMessage) => {
  broadcastSessionEvent(msg);
});

// ── Message Handler ──────────────────────────────────────────

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
            effort?: "low" | "medium" | "high" | "max";
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
        saveState(sessionHost.getSessionRecords());
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
        saveState(sessionHost.getSessionRecords());
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
      const ok = sessionHost.sendToolResult(msg.sessionId, msg.toolUseId, msg.content, msg.isError);
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

// ── Bun Server ───────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // Health endpoint for watchdog
    if (url.pathname === "/health") {
      const sessions = sessionHost.list();
      return Response.json({
        ok: true,
        uptime: process.uptime(),
        sessions: sessions.length,
        clients: clients.size,
      });
    }

    // WebSocket upgrade
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
    open(ws) {
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

log.info(`Agent Host server listening on port ${PORT}`);

// ── Periodic State Persistence ───────────────────────────────

const STATE_SAVE_INTERVAL = 30_000; // 30 seconds
const stateSaveTimer = setInterval(() => {
  const records = sessionHost.getSessionRecords();
  // Persist even when empty so stale non-running sessions are pruned from disk.
  saveState(records);
}, STATE_SAVE_INTERVAL);

let idleReapRunning = false;
const idleReapTimer = setInterval(async () => {
  if (idleReapRunning) return;
  idleReapRunning = true;
  try {
    const closedIds = await sessionHost.reapIdleRunningSessions(IDLE_STALE_MS);
    if (closedIds.length > 0) {
      // Remove closed-session subscriptions from connected clients.
      for (const [, client] of clients) {
        for (const sessionId of closedIds) {
          client.subscribedSessions.delete(sessionId);
        }
      }
      saveState(sessionHost.getSessionRecords());
      log.info("Auto-closed idle SDK sessions", {
        idleMs: IDLE_STALE_MS,
        count: closedIds.length,
        sessions: closedIds.map((id) => id.slice(0, 8)),
      });
    }
  } catch (error) {
    log.warn("Idle session reaper failed", { error: String(error) });
  } finally {
    idleReapRunning = false;
  }
}, IDLE_REAP_INTERVAL_MS);

// ── Graceful Shutdown ────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info(`Received ${signal}, shutting down...`);

  // Stop periodic saves
  clearInterval(stateSaveTimer);
  clearInterval(idleReapTimer);

  // Persist final state
  saveState(sessionHost.getSessionRecords());

  // Close all sessions
  await sessionHost.closeAll();

  // Close server
  server.stop();

  log.info("Agent Host shut down cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
