/**
 * Claudia Gateway
 *
 * The heart of Claudia - manages Claude Code sessions, routes messages
 * between clients and extensions, broadcasts events.
 *
 * Single server: serves both the web UI (SPA) and WebSocket on port 30086.
 */

import type { ServerWebSocket } from "bun";
import type {
  Request,
  Response as GatewayResponse,
  Event,
  Message,
  Ping,
  GatewayEvent,
} from "@claudia/shared";
import { loadConfig, createLogger, matchesEventPattern } from "@claudia/shared";
export type { GatewayEvent };
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "./extensions";
import { getDb, closeDb } from "./db/index";
import { homedir } from "node:os";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BUILTIN_METHODS, BUILTIN_METHODS_BY_NAME } from "./methods";

// Web UI — served as SPA fallback for all non-WS routes
import index from "./web/index.html";
// @ts-ignore - Bun's file import syntax
import serviceWorker from "./web/service-worker.js" with { type: "file" };
import manifestData from "./web/manifest.json";

// Load configuration (claudia.json or env var fallback)
const config = loadConfig();
const PORT = config.gateway.port;
const DATA_DIR = process.env.CLAUDIA_DATA_DIR || join(homedir(), ".claudia");

// Structured logger — writes to console + ~/.claudia/logs/gateway.log
const log = createLogger("Gateway", join(DATA_DIR, "logs", "gateway.log"));

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  await Bun.write(join(DATA_DIR, ".gitkeep"), "");
}

interface ClientState {
  id: string;
  connectedAt: Date;
  subscriptions: Set<string>;
  lastPong: number; // Date.now() — initialized on connect, updated on pong
}

// Client connections
const clients = new Map<ServerWebSocket<ClientState>, ClientState>();

// Exclusive subscriptions: pattern → WebSocket. Last subscriber wins.
// Used by dominatrix Chrome extensions so only the focused profile handles commands.
const exclusiveSubscribers = new Map<string, ServerWebSocket<ClientState>>();

// ── Client Health Beacon ─────────────────────────────────────
// Tracks client-side errors and heartbeats for the watchdog.
// Errors are event-driven (pushed immediately), health is inferred
// from heartbeat freshness + absence of recent errors.

interface ClientErrorReport {
  type: "react" | "runtime" | "unhandled_rejection";
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  timestamp: string;
  userAgent: string;
  receivedAt: number;
}

const MAX_CLIENT_ERRORS = 20;
const CLIENT_ERROR_TTL = 5 * 60 * 1000; // Keep errors for 5 minutes
const clientErrors: ClientErrorReport[] = [];
let lastClientHeartbeat: number | null = null;
let lastClientRendered: boolean | null = null;

function addClientError(error: Omit<ClientErrorReport, "receivedAt">): void {
  // Deduplicate: if the last error has the same message, just update its timestamp
  const last = clientErrors[clientErrors.length - 1];
  if (last && last.message === error.message) {
    last.receivedAt = Date.now();
    last.timestamp = error.timestamp;
    return;
  }

  clientErrors.push({ ...error, receivedAt: Date.now() });
  // Trim old errors
  const cutoff = Date.now() - CLIENT_ERROR_TTL;
  while (clientErrors.length > 0 && clientErrors[0].receivedAt < cutoff) {
    clientErrors.shift();
  }
  // Cap size
  while (clientErrors.length > MAX_CLIENT_ERRORS) {
    clientErrors.shift();
  }
  log.warn("Client error reported", { type: error.type, message: error.message.slice(0, 200) });
}

function getClientHealth(): {
  healthy: boolean;
  rendered: boolean | null;
  lastHeartbeat: string | null;
  heartbeatAge: number | null;
  recentErrors: number;
  errors: ClientErrorReport[];
} {
  // Prune stale errors
  const cutoff = Date.now() - CLIENT_ERROR_TTL;
  while (clientErrors.length > 0 && clientErrors[0].receivedAt < cutoff) {
    clientErrors.shift();
  }

  const heartbeatAge = lastClientHeartbeat ? Date.now() - lastClientHeartbeat : null;
  const noErrors = clientErrors.length === 0;
  const heartbeatFresh = heartbeatAge === null || heartbeatAge < 120_000;
  const rendered = lastClientRendered !== false; // null (no data yet) is OK

  return {
    healthy: noErrors && heartbeatFresh && rendered,
    rendered: lastClientRendered,
    lastHeartbeat: lastClientHeartbeat ? new Date(lastClientHeartbeat).toISOString() : null,
    heartbeatAge,
    recentErrors: clientErrors.length,
    errors: clientErrors,
  };
}

// Extension manager
const extensions = new ExtensionManager();

// Initialize database (runs migrations)
getDb();

/**
 * Unified event handler for all out-of-process extension events.
 * Handles connection-scoped routing (gateway.caller), cross-extension broadcast, and WS fan-out.
 * connectionId and tags flow on the envelope, NOT in extension payloads.
 */
function handleExtensionEvent(
  type: string,
  payload: unknown,
  source: string,
  connectionId?: string,
  tags?: string[],
): void {
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;

  // Log streaming events for debugging (filter out noisy events)
  if (!["ping", "heartbeat"].includes(type)) {
    const payloadSummary = payloadObj
      ? {
          ...(payloadObj.status ? { status: payloadObj.status } : {}),
          ...(payloadObj.message ? { message: String(payloadObj.message).slice(0, 100) } : {}),
          ...(payloadObj.attempt ? { attempt: payloadObj.attempt } : {}),
          ...(payloadObj.text ? { text: String(payloadObj.text).slice(0, 50) + "..." } : {}),
        }
      : payload;
    log.info("Event", { type, source, connectionId, tags, payload: payloadSummary });
  }

  // Determine source extension ID for loop prevention
  const sourceExtId = source?.startsWith("extension:")
    ? source.slice("extension:".length)
    : undefined;

  // gateway.caller routing — send only to originating connection
  if (source === "gateway.caller" && connectionId) {
    for (const [ws, state] of clients) {
      if (state.id === connectionId) {
        const event: Event = { type: "event", event: type, payload };
        ws.send(JSON.stringify(event));
        break;
      }
    }
    // Forward to extension handlers (but not WS clients — already handled above)
    extensions.broadcast(
      {
        type,
        payload,
        timestamp: Date.now(),
        origin: source,
        connectionId,
        tags,
      },
      sourceExtId,
    );
    return;
  }

  broadcastEvent(type, payload, source, connectionId, tags);

  // Forward to other extensions — skip the one that emitted (loop prevention)
  extensions.broadcast(
    {
      type,
      payload,
      timestamp: Date.now(),
      origin: source,
      source,
      sessionId: (payloadObj?.sessionId as string) || undefined,
      connectionId,
      tags,
    },
    sourceExtId,
  );
}

// Generate unique IDs
const generateId = () => crypto.randomUUID();

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(ws: ServerWebSocket<ClientState>, data: string): void {
  try {
    const message: Message = JSON.parse(data);

    if (message.type === "pong") {
      ws.data.lastPong = Date.now();
      return;
    }

    if (message.type === "req") {
      // Stamp connectionId on the envelope — flows through the entire pipeline
      message.connectionId = ws.data.id;
      handleRequest(ws, message);
    }
  } catch (error) {
    log.error("Failed to parse message", { error: String(error) });
    sendError(ws, "unknown", "Invalid message format");
  }
}

/**
 * Route requests to handlers.
 *
 * Gateway is a pure hub — only `gateway.*` methods are handled locally.
 * Everything else routes through the extension system.
 */
function handleRequest(ws: ServerWebSocket<ClientState>, req: Request): void {
  // Validate builtin methods
  const methodDef = BUILTIN_METHODS_BY_NAME.get(req.method);
  if (methodDef) {
    const parsed = methodDef.inputSchema.safeParse(req.params ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "params"}: ${i.message}`,
      );
      sendError(ws, req.id, `Invalid params for ${req.method}: ${issues.join("; ")}`);
      return;
    }
    req.params = parsed.data as Record<string, unknown>;
  }

  switch (req.method) {
    case "gateway.list_methods":
      handleListMethods(ws, req);
      break;
    case "gateway.list_extensions":
      handleListExtensions(ws, req);
      break;
    case "gateway.subscribe":
      handleSubscribe(ws, req);
      break;
    case "gateway.unsubscribe":
      handleUnsubscribe(ws, req);
      break;
    case "gateway.restart_extension":
      handleRestartExtension(ws, req);
      break;
    default:
      // Everything else routes through extensions
      if (extensions.hasMethod(req.method)) {
        handleExtensionMethod(ws, req);
      } else {
        sendError(ws, req.id, `Unknown method: ${req.method}`);
      }
  }
}

/**
 * gateway.list_methods — list all gateway and extension methods with schemas
 */
function handleListMethods(ws: ServerWebSocket<ClientState>, req: Request): void {
  const builtin = BUILTIN_METHODS.map((m) => ({
    method: m.method,
    source: "gateway",
    description: m.description,
    inputSchema: zodToJsonSchema(m.inputSchema, m.method),
  }));
  const extensionMethods = extensions.getMethodDefinitions().map((m) => {
    // Remote extensions don't have Zod schemas — their inputSchema is a plain object
    let inputSchema: unknown;
    try {
      inputSchema = zodToJsonSchema(m.method.inputSchema, m.method.name);
    } catch {
      inputSchema = m.method.inputSchema ?? {};
    }
    let outputSchema: unknown;
    if (m.method.outputSchema) {
      try {
        outputSchema = zodToJsonSchema(m.method.outputSchema, `${m.method.name}.output`);
      } catch {
        outputSchema = m.method.outputSchema;
      }
    }
    return {
      method: m.method.name,
      source: "extension",
      extensionId: m.extensionId,
      extensionName: m.extensionName,
      description: m.method.description,
      inputSchema,
      outputSchema,
    };
  });
  sendResponse(ws, req.id, { methods: [...builtin, ...extensionMethods] });
}

/**
 * gateway.list_extensions — list loaded extensions and their methods
 */
function handleListExtensions(ws: ServerWebSocket<ClientState>, req: Request): void {
  sendResponse(ws, req.id, { extensions: extensions.getExtensionList() });
}

/**
 * Handle extension method calls — routes through the extension system
 */
async function handleExtensionMethod(
  ws: ServerWebSocket<ClientState>,
  req: Request,
): Promise<void> {
  const start = Date.now();
  try {
    log.info(`→ ${req.method}`, { connectionId: req.connectionId?.slice(0, 8) });
    const result = await extensions.handleMethod(
      req.method,
      (req.params as Record<string, unknown>) || {},
      req.connectionId,
      undefined, // meta (traceId, depth, deadlineMs)
      req.tags,
    );
    const elapsed = Date.now() - start;
    if (elapsed > 200) {
      log.info(`← ${req.method} OK (${elapsed}ms)`);
    }
    sendResponse(ws, req.id, result);
  } catch (error) {
    const elapsed = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log.error(`← ${req.method} FAILED (${elapsed}ms)`, { error: errorMessage });
    sendError(ws, req.id, errorMessage);
  }
}

/**
 * Handle subscribe requests
 */
function handleSubscribe(ws: ServerWebSocket<ClientState>, req: Request): void {
  const state = clients.get(ws);
  if (!state) return;

  const events = (req.params?.events as string[]) || [];
  const exclusive = (req.params?.exclusive as boolean) || false;

  events.forEach((event) => {
    state.subscriptions.add(event);
    if (exclusive) {
      exclusiveSubscribers.set(event, ws);
    }
  });

  sendResponse(ws, req.id, { subscribed: events, exclusive });
}

/**
 * Handle unsubscribe requests
 */
function handleUnsubscribe(ws: ServerWebSocket<ClientState>, req: Request): void {
  const state = clients.get(ws);
  if (!state) return;

  const events = (req.params?.events as string[]) || [];
  events.forEach((event) => state.subscriptions.delete(event));

  sendResponse(ws, req.id, { unsubscribed: events });
}

/**
 * gateway.restart_extension — kill and re-spawn an extension host process.
 * Manual HMR for extensions running with hot:false (e.g. session).
 */
async function handleRestartExtension(
  ws: ServerWebSocket<ClientState>,
  req: Request,
): Promise<void> {
  const extensionId = req.params?.extension as string;
  const host = extensions.getHost(extensionId);
  if (!host) {
    const available = extensions.getExtensionIds().join(", ");
    sendError(ws, req.id, `Extension "${extensionId}" not found. Available: ${available}`);
    return;
  }

  try {
    const registration = await host.restart();
    log.info("Extension restarted", {
      extensionId,
      methods: registration.methods.map((m) => m.name),
    });
    sendResponse(ws, req.id, {
      ok: true,
      extensionId,
      methods: registration.methods.map((m) => m.name),
    });
  } catch (error) {
    log.error("Failed to restart extension", { extensionId, error: String(error) });
    sendError(ws, req.id, `Failed to restart ${extensionId}: ${error}`);
  }
}

/**
 * Send a response to a client
 */
function sendResponse(ws: ServerWebSocket<ClientState>, id: string, payload: unknown): void {
  const response: GatewayResponse = { type: "res", id, ok: true, payload };
  ws.send(JSON.stringify(response));
}

/**
 * Send an error response to a client
 */
function sendError(ws: ServerWebSocket<ClientState>, id: string, error: string): void {
  const response: GatewayResponse = { type: "res", id, ok: false, error };
  ws.send(JSON.stringify(response));
}

/**
 * Broadcast an event to subscribed WS clients.
 * Connection-scoped routing (gateway.caller) is handled in handleExtensionEvent before this.
 */
function broadcastEvent(
  eventName: string,
  payload: unknown,
  _source?: string,
  _connectionId?: string,
  _tags?: string[],
): void {
  const event: Event = { type: "event", event: eventName, payload };
  const data = JSON.stringify(event);
  let clientCount = 0;

  // 1. Exclusive subscriber — last subscriber wins, only they get the event
  const exclusiveWs = exclusiveSubscribers.get(eventName);
  if (exclusiveWs && clients.has(exclusiveWs)) {
    exclusiveWs.send(data);
    clientCount = 1;
    if (!["ping", "heartbeat"].includes(eventName)) {
      log.info("Broadcast exclusive", { event: eventName, clients: clientCount });
    }
    return;
  }

  // 2. Standard subscription matching for all clients
  for (const [ws, state] of clients) {
    const isSubscribed = Array.from(state.subscriptions).some((pattern) =>
      matchesEventPattern(eventName, pattern),
    );

    if (isSubscribed) {
      ws.send(data);
      clientCount++;
    }
  }

  // Log broadcast (filter out noisy events)
  if (!["ping", "heartbeat"].includes(eventName) && clientCount > 0) {
    // Add detailed logging for debugging streaming issues
    if (eventName.startsWith("session.")) {
      const sessionEventType = eventName.split(".").slice(2).join(".");
      log.info("Session Event", {
        event: sessionEventType,
        clients: clientCount,
        payload:
          typeof payload === "object" ? JSON.stringify(payload).slice(0, 200) + "..." : payload,
      });
    } else {
      log.info("Broadcast", { event: eventName, clients: clientCount });
    }
  }
}

// Combined HTTP + WebSocket server (single port, like claudia-code)
const server = Bun.serve<ClientState>({
  port: PORT,
  hostname: config.gateway.host || "localhost",
  reusePort: false,
  // Custom fetch handler for WebSocket upgrades
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade — only on /ws
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: {
          id: generateId(),
          connectedAt: new Date(),
          subscriptions: new Set<string>(),
          lastPong: Date.now(),
        },
      });

      if (upgraded) return undefined as unknown as globalThis.Response;
      return new globalThis.Response("WebSocket upgrade failed", {
        status: 400,
      });
    }

    // Fall through to routes
    return null as unknown as globalThis.Response;
  },
  routes: {
    // Health check endpoint
    "/health": () => {
      return new globalThis.Response(
        JSON.stringify({
          status: "ok",
          clients: clients.size,
          extensions: extensions.getHealth(),
          sourceRoutes: extensions.getSourceRoutes(),
          client: getClientHealth(),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },

    // Client error beacon — receives crash reports from the web UI
    "/api/client-error": async (req: globalThis.Request) => {
      if (req.method !== "POST") {
        return new globalThis.Response("Method not allowed", { status: 405 });
      }
      try {
        const body = await req.json();
        addClientError(body);
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new globalThis.Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    },

    // Client health heartbeat — confirms the web UI is rendering successfully
    "/api/client-health": async (req: globalThis.Request) => {
      if (req.method !== "POST") {
        return new globalThis.Response("Method not allowed", { status: 405 });
      }
      try {
        const body = (await req.json()) as {
          rendered?: boolean;
          bunHmrError?: string | null;
        };
        lastClientRendered = body.rendered ?? true;

        // If the DOM health check found a bun-hmr error overlay, treat it as a client error
        if (body.bunHmrError) {
          addClientError({
            type: "runtime",
            message: body.bunHmrError,
            url: req.headers.get("referer") || "",
            timestamp: new Date().toISOString(),
            userAgent: req.headers.get("user-agent") || "",
          });
        } else if (body.rendered) {
          // Client is rendering successfully — clear any stale errors immediately
          clientErrors.length = 0;
        }
      } catch {
        lastClientRendered = true;
      }
      lastClientHeartbeat = Date.now();
      return new globalThis.Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },

    // PWA files
    "/service-worker.js": () => {
      return new globalThis.Response(Bun.file(serviceWorker), {
        headers: {
          "Content-Type": "application/javascript",
          "Service-Worker-Allowed": "/",
        },
      });
    },
    "/manifest.json": () => {
      return new globalThis.Response(JSON.stringify(manifestData), {
        headers: { "Content-Type": "application/json" },
      });
    },
    // PWA icons — must be before SPA fallback
    "/icons/*": (req: globalThis.Request) => {
      const url = new URL(req.url);
      const filename = url.pathname.slice("/icons/".length);
      if (filename && !filename.includes("..") && !filename.includes("/")) {
        const iconPath = join(import.meta.dir, "web", "public", "icons", filename);
        return new globalThis.Response(Bun.file(iconPath), {
          headers: { "Content-Type": "image/png" },
        });
      }
      return new globalThis.Response("Not found", { status: 404 });
    },

    // Static file serving for extensions (audiobooks, etc.)
    "/audiobooks/static/*": (req: globalThis.Request) => {
      const url = new URL(req.url);
      const relativePath = url.pathname.slice("/audiobooks/static/".length);

      // Security: prevent directory traversal
      if (!relativePath || relativePath.includes("..")) {
        return new globalThis.Response("Not found", { status: 404 });
      }

      // Resolve base path (~/romance-novels)
      const basePath = join(homedir(), "romance-novels");
      const filePath = join(basePath, relativePath);

      // Ensure the resolved path is still within basePath
      if (!filePath.startsWith(basePath)) {
        return new globalThis.Response("Not found", { status: 404 });
      }

      // Determine content type from extension
      const ext = filePath.split(".").pop()?.toLowerCase();
      const contentType =
        {
          mp3: "audio/mpeg",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          md: "text/markdown; charset=utf-8",
          json: "application/json",
        }[ext || ""] || "application/octet-stream";

      const file = Bun.file(filePath);

      // Check if file exists by checking size (Bun's exists check)
      return file.size > 0
        ? new globalThis.Response(file, {
            headers: {
              "Content-Type": contentType,
              "Accept-Ranges": "bytes", // Support range requests for audio seeking
              "Cache-Control": "public, max-age=31536000", // Cache for 1 year
            },
          })
        : new globalThis.Response("Not found", { status: 404 });
    },

    // SPA fallback — serves the web UI for all other paths
    "/*": index,
  },
  websocket: {
    open(ws) {
      clients.set(ws, ws.data);
      log.info(`Client connected: ${ws.data.id} (${clients.size} total)`);

      // Send the server-authoritative connectionId to the client
      ws.send(
        JSON.stringify({
          type: "event",
          event: "gateway.welcome",
          payload: { connectionId: ws.data.id },
        }),
      );
    },
    message(ws, message) {
      handleMessage(ws, message.toString());
    },
    close(ws) {
      clients.delete(ws);

      // Clean up exclusive subscriptions held by this connection
      for (const [pattern, exclusiveWs] of exclusiveSubscribers) {
        if (exclusiveWs === ws) exclusiveSubscribers.delete(pattern);
      }

      // Notify extensions that this client disconnected (connectionId on envelope)
      broadcastEvent("client.disconnected", {}, undefined, ws.data.id);
      extensions.broadcast({
        type: "client.disconnected",
        payload: {},
        timestamp: Date.now(),
        origin: "gateway",
        connectionId: ws.data.id,
      });

      log.info(`Client disconnected: ${ws.data.id} (${clients.size} total)`);
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

log.info(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   💙 Claudia running on http://localhost:${PORT}           ║
║                                                           ║
║   Web UI:    http://localhost:${PORT}                      ║
║   WebSocket: ws://localhost:${PORT}/ws                     ║
║   Health:    http://localhost:${PORT}/health               ║
║                                                           ║
║   Model:    ${config.session.model.padEnd(42)}║
║   Thinking: ${String(config.session.thinking).padEnd(42)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

// ── Ping/Pong — Connection Liveness ─────────────────────────────────
// Every 30s, send a ping to all WS clients and prune those that haven't
// responded within 60s (missed 2 consecutive pings).

const PING_INTERVAL_MS = 30_000;
const PONG_STALE_MS = 60_000;

function pruneClient(ws: ServerWebSocket<ClientState>): void {
  const state = clients.get(ws);
  if (!state) return;

  log.info(`Pruning stale client: ${state.id}`);

  clients.delete(ws);

  // Clean up exclusive subscriptions
  for (const [pattern, exclusiveWs] of exclusiveSubscribers) {
    if (exclusiveWs === ws) exclusiveSubscribers.delete(pattern);
  }

  // Notify extensions
  broadcastEvent("client.disconnected", {}, undefined, state.id);
  extensions.broadcast({
    type: "client.disconnected",
    payload: {},
    timestamp: Date.now(),
    origin: "gateway",
    connectionId: state.id,
  });

  try {
    ws.close();
  } catch {
    // Already closed
  }
}

const pingInterval = setInterval(() => {
  const now = Date.now();

  for (const [ws, state] of clients) {
    // Prune clients that haven't responded to pings
    if (now - state.lastPong > PONG_STALE_MS) {
      pruneClient(ws);
      continue;
    }

    // Send ping
    const ping: Ping = { type: "ping", id: crypto.randomUUID(), timestamp: now };
    try {
      ws.send(JSON.stringify(ping));
    } catch {
      // Send failed — prune immediately
      pruneClient(ws);
    }
  }
}, PING_INTERVAL_MS);

// Graceful shutdown — handle all termination signals
async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down...`);
  try {
    clearInterval(pingInterval);
    server.stop();
    await extensions.killRemoteHosts();
    closeDb();
  } catch (e) {
    log.error("Error during shutdown", { error: String(e) });
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Last-resort synchronous cleanup: force-kill extension hosts on process exit
// This catches cases where async shutdown didn't complete (e.g. bun --watch)
process.on("exit", () => {
  extensions.forceKillRemoteHosts();
});

// HMR cleanup — dispose managers when module reloads during development
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    log.info("HMR: Disposing managers...");
    clearInterval(pingInterval);
    server.stop();
    await extensions.killRemoteHosts();
    closeDb();
  });
}

export { server, broadcastEvent, handleExtensionEvent, extensions };
