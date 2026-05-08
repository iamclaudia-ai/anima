/**
 * Anima Gateway
 *
 * The heart of Anima - manages Claude Code sessions, routes messages
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
} from "@anima/shared";
import { loadConfig, createLogger, matchesEventPattern } from "@anima/shared";
import { initAuth, authenticateRequest, resetCachedToken } from "./auth";
export type { GatewayEvent };
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "./extensions";
import { getDb, closeDb } from "./db/index";
import { getExtensionProcessLocks } from "./db/extension-locks";
import {
  acquireExtensionRuntimeLock,
  getExtensionRuntimeLocks,
  releaseExtensionRuntimeLock,
  renewExtensionRuntimeLock,
} from "./db/runtime-locks";
import { homedir } from "node:os";
import { z } from "zod";
import { BUILTIN_METHODS, BUILTIN_METHODS_BY_NAME } from "./methods";
import { WebSocketExtensionHost } from "./ws-extension-host";
import type { ExtensionRegistration, OnCallCallback } from "./extension-host";
import { handleGatewayMcpRequest } from "./mcp-proxy";
import { buildExtensionBundle, getExtensionRoutesPath } from "./web/extension-bundler";
import { buildVendorBundles, getVendorBundle } from "./web/vendor-bundler";
import { buildSpaBundle } from "./web/spa-bundler";
import { contentTypeFor, discoverAllConventionWebStatic, mergeWebStatic } from "./web/static-paths";
import { getAsset } from "./web/asset-cache";
import type { WebStaticPath } from "@anima/shared";
import { getExtensionConfig, getExtensionWebConfig } from "@anima/shared";

// Web UI — served as SPA fallback for all non-WS routes
// Served as a plain file, not Bun's HTML magic mode — auto-bundling no
// longer applies now that the script src is /spa.js (built by spa-bundler).
// @ts-ignore - Bun's file import syntax
import indexHtml from "./web/index.html" with { type: "file" };
// @ts-ignore - Bun's file import syntax
import serviceWorker from "./web/service-worker.js" with { type: "file" };
import manifestData from "./web/manifest.json";

// Load configuration (anima.json or env var fallback)
const config = loadConfig();
const PORT = config.gateway.port;

// Initialize auth — auto-generates token on first run
const authResult = initAuth();
const DATA_DIR = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
const sessionExtConfig = (config.extensions?.session?.config || {}) as Record<string, unknown>;
const sessionExtensionEnabled = Boolean(config.extensions?.session?.enabled);
const sessionModel = (() => {
  if (!sessionExtensionEnabled) return "disabled";
  const model = sessionExtConfig.model;
  if (typeof model === "string" && model.trim().length > 0) {
    return model.trim();
  }
  throw new Error(
    "Missing required config: extensions.session.config.model in ~/.anima/anima.json",
  );
})();
const sessionThinking =
  typeof sessionExtConfig.thinking === "boolean" ? String(sessionExtConfig.thinking) : "false";

// Structured logger — writes to console + ~/.anima/logs/gateway.log
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

// WebSocket extension hosts: maps a WS connection to its extension host.
// When a client calls gateway.register_extension, the connection becomes both
// a regular client AND an extension host.
const wsExtensionHosts = new Map<ServerWebSocket<ClientState>, WebSocketExtensionHost>();

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

// Seed static-path registry from filesystem conventions + anima.json overrides
// BEFORE extensions register. UI-only extensions (those without a server-side
// AnimaExtension, like bogart) get static serving from this seed alone — they
// never call registerRemote so their convention paths would otherwise be lost.
// Server-backed extensions later re-merge with their code-declared webStatic
// at registration time.
{
  const seenIds = new Set<string>();
  for (const { extensionId, paths } of discoverAllConventionWebStatic()) {
    seenIds.add(extensionId);
    const configStatic = (getExtensionConfig(extensionId)?.webStatic ?? []) as WebStaticPath[];
    extensions.staticPaths.set(extensionId, mergeWebStatic(paths, configStatic));
  }
  // Also pick up anima.json-only entries (extension with no static/ dir but
  // with config-declared webStatic).
  for (const [extensionId, ext] of Object.entries(config.extensions ?? {})) {
    if (seenIds.has(extensionId)) continue;
    const configStatic = (ext.webStatic ?? []) as WebStaticPath[];
    if (configStatic.length > 0) {
      extensions.staticPaths.set(extensionId, configStatic);
    }
  }
}

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
  meta?: { extensionId?: string; generationToken?: string },
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
    : meta?.extensionId;

  if (sourceExtId && !extensions.isCurrentGeneration(sourceExtId, meta?.generationToken)) {
    log.warn("Dropping stale extension event", {
      type,
      source,
      extensionId: sourceExtId,
      generation: meta?.generationToken ?? null,
      currentGeneration: extensions.getGeneration(sourceExtId),
    });
    return;
  }

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

    // If this WS is a registered extension host, route non-req messages
    // (res, event, call) to the host handler. Req messages still flow
    // through normal handleRequest so the extension can also call methods.
    const wsHost = wsExtensionHosts.get(ws);
    if (wsHost && message.type !== "req") {
      wsHost.handleMessage(message as unknown as Record<string, unknown>);
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
    case "gateway.subscribe":
      handleSubscribe(ws, req);
      return;
    case "gateway.unsubscribe":
      handleUnsubscribe(ws, req);
      return;
    case "gateway.register_extension":
      handleRegisterExtension(ws, req);
      return;
  }

  if (req.method.startsWith("gateway.")) {
    void (async () => {
      try {
        const payload = await executeGatewayMethod(req.method, req.params ?? {}, {
          connectionId: req.connectionId,
        });
        sendResponse(ws, req.id, payload);
      } catch (error) {
        sendError(ws, req.id, error instanceof Error ? error.message : String(error));
      }
    })();
    return;
  }

  // Everything else routes through extensions
  if (extensions.hasMethod(req.method)) {
    handleExtensionMethod(ws, req);
  } else {
    sendError(ws, req.id, `Unknown method: ${req.method}`);
  }
}

export async function executeGatewayMethod(
  method: string,
  params: Record<string, unknown>,
  options: { connectionId?: string; callerExtensionId?: string } = {},
): Promise<unknown> {
  const methodDef = BUILTIN_METHODS_BY_NAME.get(method);
  if (methodDef) {
    const parsed = methodDef.inputSchema.safeParse(params ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "params"}: ${i.message}`,
      );
      throw new Error(`Invalid params for ${method}: ${issues.join("; ")}`);
    }
    params = parsed.data as Record<string, unknown>;
  }

  switch (method) {
    case "gateway.list_methods":
      return buildListMethodsResponse();
    case "gateway.list_extensions":
      return { extensions: extensions.getExtensionList() };
    case "gateway.list_web_contributions":
      return {
        contributions: extensions
          .getExtensionList()
          .filter((ext) => getExtensionRoutesPath(ext.id) !== null)
          .map((ext) => ({
            extensionId: ext.id,
            jsUrl: `/extensions/${ext.id}/web-bundle.js`,
            webConfig: getExtensionWebConfig(ext.id),
          })),
      };
    case "gateway.acquire_liveness_lock": {
      const extensionId = resolveLockExtensionId(params, options.callerExtensionId);
      const result = acquireExtensionRuntimeLock({
        extensionId,
        lockType: params.lockType as "singleton" | "processing" | "lease",
        resourceKey: typeof params.resourceKey === "string" ? params.resourceKey : undefined,
        holderPid: typeof params.holderPid === "number" ? params.holderPid : null,
        holderInstanceId: params.holderInstanceId as string,
        staleAfterMs: typeof params.staleAfterMs === "number" ? params.staleAfterMs : undefined,
        metadata: isRecord(params.metadata) ? params.metadata : undefined,
      });
      return result;
    }
    case "gateway.renew_liveness_lock": {
      const extensionId = resolveLockExtensionId(params, options.callerExtensionId);
      return {
        renewed: renewExtensionRuntimeLock({
          extensionId,
          lockType: params.lockType as string,
          resourceKey: typeof params.resourceKey === "string" ? params.resourceKey : undefined,
          holderPid: typeof params.holderPid === "number" ? params.holderPid : null,
          holderInstanceId: params.holderInstanceId as string,
          staleAfterMs: typeof params.staleAfterMs === "number" ? params.staleAfterMs : undefined,
          metadata: isRecord(params.metadata) ? params.metadata : undefined,
        }),
      };
    }
    case "gateway.release_liveness_lock": {
      const extensionId = resolveLockExtensionId(params, options.callerExtensionId);
      return {
        released: releaseExtensionRuntimeLock({
          extensionId,
          lockType: params.lockType as string,
          resourceKey: typeof params.resourceKey === "string" ? params.resourceKey : undefined,
          holderPid: typeof params.holderPid === "number" ? params.holderPid : null,
          holderInstanceId: params.holderInstanceId as string,
        }),
      };
    }
    case "gateway.list_liveness_locks":
      return {
        locks: getExtensionRuntimeLocks(
          typeof params.extension === "string" ? params.extension : undefined,
        ),
      };
    case "gateway.subscribe":
    case "gateway.unsubscribe":
    case "gateway.register_extension":
      throw new Error(`${method} is only available over a direct client connection`);
    case "gateway.restart_extension": {
      const extensionId = params.extension as string;
      const host = extensions.getHost(extensionId);
      if (!host) {
        const available = extensions.getExtensionIds().join(", ");
        throw new Error(`Extension "${extensionId}" not found. Available: ${available}`);
      }
      const registration = await host.restart();
      log.info("Extension restarted", {
        extensionId,
        methods: registration.methods.map((m) => m.name),
      });
      return {
        ok: true,
        extensionId,
        methods: registration.methods.map((m) => m.name),
      };
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveLockExtensionId(
  params: Record<string, unknown>,
  callerExtensionId?: string,
): string {
  const extensionId =
    typeof params.extension === "string" && params.extension.length > 0
      ? params.extension
      : callerExtensionId;
  if (!extensionId) {
    throw new Error("Missing extension for liveness lock operation");
  }
  return extensionId;
}

function buildListMethodsResponse(): { methods: Array<Record<string, unknown>> } {
  // `io: "input"` for inputs: fields with .default() are not required (the
  // user doesn't have to send them — Zod fills the default). For outputs we
  // use the default "output" mode: defaulted fields are guaranteed present in
  // responses, so they're correctly required there.
  const builtin = BUILTIN_METHODS.map((m) => ({
    method: m.method,
    source: "gateway",
    description: m.description,
    inputSchema: z.toJSONSchema(m.inputSchema as z.ZodType, { io: "input" }),
  }));
  const extensionMethods = extensions.getMethodDefinitions().map((m) => {
    let inputSchema: unknown;
    try {
      inputSchema = z.toJSONSchema(m.method.inputSchema as z.ZodType, { io: "input" });
    } catch {
      inputSchema = m.method.inputSchema ?? {};
    }
    let outputSchema: unknown;
    if (m.method.outputSchema) {
      try {
        outputSchema = z.toJSONSchema(m.method.outputSchema as z.ZodType);
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
  return { methods: [...builtin, ...extensionMethods] };
}

/**
 * gateway.list_methods — list all gateway and extension methods with schemas
 */
function handleListMethods(ws: ServerWebSocket<ClientState>, req: Request): void {
  sendResponse(ws, req.id, buildListMethodsResponse());
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
  try {
    const payload = await executeGatewayMethod("gateway.restart_extension", req.params ?? {}, {
      connectionId: req.connectionId,
    });
    sendResponse(ws, req.id, payload);
  } catch (error) {
    const extensionId = req.params?.extension as string;
    log.error("Failed to restart extension", { extensionId, error: String(error) });
    sendError(ws, req.id, `Failed to restart ${extensionId}: ${error}`);
  }
}

/**
 * gateway.register_extension — register this WebSocket connection as an extension host.
 * After registration, the connection can receive method calls, emit events,
 * and use ctx.call() to invoke other extensions — same protocol as NDJSON hosts.
 */
function handleRegisterExtension(ws: ServerWebSocket<ClientState>, req: Request): void {
  const params = req.params as {
    id: string;
    name: string;
    methods: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
    mcpTools?: Array<{
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }>;
    events: string[];
    sourceRoutes: string[];
  };

  // Prevent collision with existing extensions
  if (extensions.getHost(params.id)) {
    sendError(
      ws,
      req.id,
      `Extension "${params.id}" is already registered. Disconnect the existing host first.`,
    );
    return;
  }

  // Prevent double-registration on the same WebSocket
  if (wsExtensionHosts.has(ws)) {
    const existing = wsExtensionHosts.get(ws)!;
    sendError(
      ws,
      req.id,
      `This connection is already registered as extension "${existing.getRegistration()?.id}".`,
    );
    return;
  }

  const registration: ExtensionRegistration = {
    id: params.id,
    name: params.name,
    methods: params.methods.map((m) => ({ name: m.name, description: m.description })),
    mcpTools: params.mcpTools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: tool.annotations,
      _meta: tool._meta,
    })),
    events: params.events,
    sourceRoutes: params.sourceRoutes,
  };

  // ctx.call handler: route calls from this extension through the gateway hub
  const onCall: OnCallCallback = async (callerExtensionId, method, callParams, meta) => {
    try {
      const result = method.startsWith("gateway.")
        ? await executeGatewayMethod(method, callParams, {
            connectionId: meta.connectionId,
            callerExtensionId,
          })
        : await extensions.handleMethod(
            method,
            callParams,
            meta.connectionId,
            {
              traceId: meta.traceId,
              depth: meta.depth,
              deadlineMs: meta.deadlineMs,
            },
            meta.tags,
          );
      return { ok: true as const, payload: result };
    } catch (error) {
      // Use .message — String(err) produces "Error: <msg>" which clients
      // re-prefix and end up with "Error: Error: <msg>".
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const wsHost = new WebSocketExtensionHost(
    params.id,
    ws,
    registration,
    (type, payload, source, connectionId, tags, generationToken) =>
      handleExtensionEvent(type, payload, source || `extension:${params.id}`, connectionId, tags, {
        extensionId: params.id,
        generationToken,
      }),
    onCall,
  );

  // Register with the extension manager
  extensions.registerRemote(registration, wsHost);

  // Track the WS → host mapping for message routing and cleanup
  wsExtensionHosts.set(ws, wsHost);

  log.info("WebSocket extension registered", {
    extensionId: params.id,
    methods: registration.methods.map((m) => m.name),
    connectionId: ws.data.id,
  });

  sendResponse(ws, req.id, {
    ok: true,
    extensionId: params.id,
    methods: registration.methods.map((m) => m.name),
    generationToken: wsHost.getGenerationToken(),
  });
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

// Combined HTTP + WebSocket server (single port, like the old claudia-code layout)
const server = Bun.serve<ClientState>({
  port: PORT,
  hostname: config.gateway.host || "localhost",
  reusePort: false,
  // Custom fetch handler for WebSocket upgrades
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade — also exposed as an explicit /ws route below so that
    // Bun.serve's routes map (which runs before fetch()) doesn't let the SPA
    // wildcard "/*" hijack the upgrade. Keeping this branch in place is
    // belt-and-suspenders in case the request reaches the fetch handler.
    if (url.pathname === "/ws") {
      const auth = authenticateRequest(req);
      if (!auth.ok) {
        return new globalThis.Response(JSON.stringify({ error: auth.message }), {
          status: auth.status,
          headers: { "Content-Type": "application/json" },
        });
      }

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

    // Token validation endpoint — lets the login page verify a token
    if (url.pathname === "/api/auth/validate" && req.method === "POST") {
      const auth = authenticateRequest(req);
      return new globalThis.Response(JSON.stringify({ ok: auth.ok }), {
        status: auth.ok ? 200 : 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Protected API routes — require auth
    if (
      url.pathname === "/health" ||
      url.pathname === "/mcp" ||
      url.pathname.startsWith("/audiobooks/")
    ) {
      const auth = authenticateRequest(req);
      if (!auth.ok) {
        return new globalThis.Response(JSON.stringify({ error: auth.message }), {
          status: auth.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Fall through to routes
    // (SPA fallback serves HTML without auth — login gate is client-side)
    // (client-error and client-health beacons are exempt — they accept data but don't leak it)
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
          extensionLocks: getExtensionProcessLocks(),
          runtimeLocks: getExtensionRuntimeLocks(),
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

    "/mcp": async (req: globalThis.Request) => {
      if (!["GET", "POST", "DELETE"].includes(req.method)) {
        return new globalThis.Response("Method not allowed", { status: 405 });
      }
      return await handleGatewayMcpRequest(req, extensions, log);
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
    // WebSocket upgrade — registered explicitly so Bun.serve's routes
    // map (which runs before fetch()) doesn't let the SPA wildcard "/*"
    // serve HTML instead of upgrading the connection.
    "/ws": (req: globalThis.Request, server: globalThis.Bun.Server<ClientState>) => {
      const auth = authenticateRequest(req);
      if (!auth.ok) {
        return new globalThis.Response(JSON.stringify({ error: auth.message }), {
          status: auth.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      const upgraded = server.upgrade(req, {
        data: {
          id: generateId(),
          connectedAt: new Date(),
          subscriptions: new Set<string>(),
          lastPong: Date.now(),
        },
      });
      if (upgraded) return undefined as unknown as globalThis.Response;
      return new globalThis.Response("WebSocket upgrade failed", { status: 400 });
    },

    // SPA bundle — gateway's own web shell, built with the same shared-dep
    // externals as extension bundles so React/react-dom/@anima/ui module
    // instances are shared across the SPA and every extension.
    "/spa.js": async () => {
      const bundle = await buildSpaBundle();
      if (!bundle) {
        return new globalThis.Response("SPA bundle build failed", { status: 503 });
      }
      return new globalThis.Response(bundle.js, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    },
    "/spa.css": async () => {
      const bundle = await buildSpaBundle();
      if (!bundle) {
        return new globalThis.Response("SPA bundle build failed", { status: 503 });
      }
      return new globalThis.Response(bundle.css, {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    },

    // List of extensions that contribute web routes — fetched by the SPA
    // bootstrap to drive dynamic-import of each extension's bundle.
    // Mirrors the gateway.list_web_contributions WS method.
    "/api/web-contributions": () => {
      const contributions = extensions
        .getExtensionList()
        .filter((ext) => getExtensionRoutesPath(ext.id) !== null)
        .map((ext) => ({
          extensionId: ext.id,
          jsUrl: `/extensions/${ext.id}/web-bundle.js`,
          webConfig: getExtensionWebConfig(ext.id),
        }));
      return new globalThis.Response(JSON.stringify({ contributions }), {
        headers: { "Content-Type": "application/json" },
      });
    },

    // Build-time-bundled assets (PNGs, fonts, etc.) — populated by every
    // Bun.build call (vendor / SPA / extension). Filenames are content-hashed
    // so an aggressive cache header is safe.
    "/assets/*": (req: globalThis.Request) => {
      const filename = new URL(req.url).pathname.slice("/assets/".length);
      if (!filename || filename.includes("/") || filename.includes("..")) {
        return new globalThis.Response("Not found", { status: 404 });
      }
      const asset = getAsset(filename);
      if (!asset) {
        return new globalThis.Response("Asset not found", { status: 404 });
      }
      return new globalThis.Response(asset.bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": asset.contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    },

    // Vendor JS bundles — shared deps (React, @anima/ui, etc.) served once
    // and resolved by the SPA importmap. Built at startup by buildVendorBundles().
    "/vendor/*": async (req: globalThis.Request) => {
      const url = new URL(req.url);
      const tail = url.pathname.slice("/vendor/".length);
      if (!tail.endsWith(".js")) {
        return new globalThis.Response("Not found", { status: 404 });
      }
      const slug = tail.slice(0, -".js".length);
      if (!slug || slug.includes("/") || slug.includes("..")) {
        return new globalThis.Response("Not found", { status: 404 });
      }
      // Await the shared in-flight build so first-load requests that race the
      // startup warm-up don't permanently 503 the SPA module graph.
      let bundle = getVendorBundle(slug);
      if (!bundle) {
        await buildVendorBundles();
        bundle = getVendorBundle(slug);
      }
      if (!bundle) {
        return new globalThis.Response("Vendor bundle not ready", { status: 503 });
      }
      return new globalThis.Response(bundle.js, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          // Vendor bundles are stable for the gateway's lifetime; the SPA
          // re-fetches on reload anyway. Short cache lets restarts pick up
          // dep upgrades without manual cache busting.
          "Cache-Control": "no-store",
        },
      });
    },

    // Per-extension web bundles — lazy-built on first request, cached for
    // the lifetime of the gateway process. Returns 404 when an extension
    // has no routes.ts; 503 when the build fails (degrade gracefully —
    // one bad extension shouldn't take down the whole UI).
    "/extensions/*": async (req: globalThis.Request) => {
      const url = new URL(req.url);
      // Match: /extensions/<id>/web-bundle.js
      const tail = url.pathname.slice("/extensions/".length);
      const match = tail.match(/^([a-z0-9_-]+)\/web-bundle\.js$/);
      if (!match) {
        return new globalThis.Response("Not found", { status: 404 });
      }
      const extensionId = match[1] as string;
      if (getExtensionRoutesPath(extensionId) === null) {
        return new globalThis.Response("Extension has no web contribution", { status: 404 });
      }
      const bundle = await buildExtensionBundle(extensionId);
      if (!bundle) {
        return new globalThis.Response("Extension bundle build failed", { status: 503 });
      }
      return new globalThis.Response(bundle.js, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
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

    // SPA fallback — serves either an extension-contributed static file (when
    // the URL matches a registered webStatic prefix) or the SPA HTML shell.
    // Static prefixes come from the extensions' webStatic declarations merged
    // with anima.json overrides; see `web/static-paths.ts`.
    "/*": (req: globalThis.Request) => {
      const url = new URL(req.url);
      const fsPath = extensions.staticPaths.resolveFsPath(url.pathname);
      if (fsPath !== null) {
        const file = Bun.file(fsPath);
        if (file.size > 0) {
          return new globalThis.Response(file, {
            headers: {
              "Content-Type": contentTypeFor(fsPath),
              "Accept-Ranges": "bytes",
              "Cache-Control": "public, max-age=31536000",
            },
          });
        }
        return new globalThis.Response("Not found", { status: 404 });
      }
      return new globalThis.Response(Bun.file(indexHtml as unknown as string), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
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

      // Clean up WebSocket extension host if this was a registered extension
      const wsHost = wsExtensionHosts.get(ws);
      if (wsHost) {
        const extensionId = wsHost.getRegistration()?.id;
        wsHost.handleDisconnect();
        wsExtensionHosts.delete(ws);
        if (extensionId) {
          extensions.unregisterRemote(extensionId);
          log.info("WebSocket extension unregistered on disconnect", { extensionId });
        }
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
    hmr: false,
    console: true,
  },
});

const authLine = authResult.generated
  ? `Token:    ${authResult.token} (NEW — save this!)`
  : "Auth:     enabled ✓";

log.info(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   Anima running on http://localhost:${PORT}                ║
║                                                           ║
║   Web UI:    http://localhost:${PORT}                      ║
║   WebSocket: ws://localhost:${PORT}/ws                     ║
║   Health:    http://localhost:${PORT}/health               ║
║                                                           ║
║   Model:    ${sessionModel.padEnd(42)}║
║   Thinking: ${sessionThinking.padEnd(42)}║
║   ${authLine.padEnd(53)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

// Fire-and-forget bundle warm-up at startup. Failures here don't block
// startup — /vendor/*.js, /spa.js and /spa.css will 503 until builds land,
// after which they're served from in-memory cache.
Promise.all([
  buildVendorBundles().catch((error) => {
    log.error("Vendor bundle build failed at startup", {
      error: error instanceof Error ? error.message : String(error),
    });
  }),
  buildSpaBundle().catch((error) => {
    log.error("SPA bundle build failed at startup", {
      error: error instanceof Error ? error.message : String(error),
    });
  }),
]);

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

  // Clean up WebSocket extension host
  const wsHost = wsExtensionHosts.get(ws);
  if (wsHost) {
    const extensionId = wsHost.getRegistration()?.id;
    wsHost.handleDisconnect();
    wsExtensionHosts.delete(ws);
    if (extensionId) {
      extensions.unregisterRemote(extensionId);
      log.info("WebSocket extension unregistered on prune", { extensionId });
    }
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
