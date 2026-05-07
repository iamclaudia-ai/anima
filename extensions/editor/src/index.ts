/**
 * Editor Extension
 *
 * Bridges Anima clients (chat, CLI, MCP, voice — anything that can call
 * gateway methods) to a running code-server instance through a small VS Code
 * shim extension installed inside code-server (`clients/code-server-bridge/`).
 *
 * Pattern is a direct transplant of dominatrix's chrome-bridge model:
 *
 *   Caller
 *     └─ editor.open_file(...) ───► [this extension]
 *         └─ emits `editor.command` event { requestId, action, params }
 *             └─ shim (subscribed exclusively over WS) runs the action via
 *                vscode.commands.executeCommand("vscode.open", uri) etc.
 *                 └─ shim calls editor.response({ requestId, success, data })
 *                     └─ extension resolves the original promise
 *
 * Spontaneous events from the shim (active editor changed, etc.) come in via
 * `editor.notify_*` methods which the extension re-emits as public events
 * (`editor.active_file_changed`) any subscriber can listen to.
 *
 * Last-subscriber-wins on the shim side (`gateway.subscribe { exclusive: true }`)
 * — multiple code-server tabs would otherwise all try to handle the same
 * command. The extension itself just dispatches; it doesn't enforce uniqueness.
 */

import { z } from "zod";
import type {
  AnimaExtension,
  ExtensionContext,
  HealthCheckResponse,
  LoggerLike,
} from "@anima/shared";

// ============================================================================
// Types
// ============================================================================

interface ShimClient {
  /** Stable ID assigned by the shim (uuid generated on first activation) */
  instanceId: string;
  /** Connection ID assigned by the gateway (used for disconnect cleanup) */
  connectionId: string;
  /** Reported code-server version, if the shim sends it */
  codeServerVersion?: string;
  registeredAt: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  action: string;
}

// ============================================================================
// Constants
// ============================================================================

const COMMAND_TIMEOUT_MS = 15_000;

const noopLogger: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
};

// ============================================================================
// Schemas
// ============================================================================

// --- Public ---

const openFileParam = z.object({
  path: z.string().describe("Absolute path of the file to open in code-server"),
  line: z.number().int().positive().optional().describe("1-indexed line to jump to"),
  column: z.number().int().positive().optional().describe("1-indexed column to jump to"),
  preview: z
    .boolean()
    .optional()
    .describe("Open in preview mode (single-click style). Defaults to true."),
});

const getSelectionParam = z.object({});
const getActiveFileParam = z.object({});

// --- Internal (shim → extension) ---

const registerParam = z.object({
  instanceId: z.string().describe("Stable shim instance ID"),
  codeServerVersion: z.string().optional().describe("Reported code-server version"),
});

const responseParam = z.object({
  requestId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

const notifyActiveFileParam = z.object({
  path: z.string().nullable().describe("Active file path, or null when no editor is focused"),
});

// ============================================================================
// Extension Factory
// ============================================================================

export function createEditorExtension(): AnimaExtension {
  let ctx: ExtensionContext;
  let traceLog: LoggerLike = noopLogger;
  const clients = new Map<string, ShimClient>();
  const pendingRequests = new Map<string, PendingRequest>();
  // connectionId → instanceId so we can clean up on disconnect.
  const connectionMap = new Map<string, string>();

  // --------------------------------------------------------------------------
  // Command dispatch — emit `editor.command` event, await `editor.response`.
  // --------------------------------------------------------------------------

  function sendCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (clients.size === 0) {
      return Promise.reject(
        new Error(
          "No code-server bridge connected. Install the anima-bridge .vsix in code-server.",
        ),
      );
    }

    const requestId = crypto.randomUUID();
    ctx.log.info("Dispatching editor command", {
      action,
      requestId,
      clients: clients.size,
    });
    traceLog.info("Command payload", { requestId, action, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ctx.log.warn("Editor command timed out", { action, requestId });
        traceLog.warn("Command timed out", { requestId, action });
        pendingRequests.delete(requestId);
        reject(new Error(`Editor command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      pendingRequests.set(requestId, { resolve, reject, timer, action });
      ctx.emit("editor.command", { requestId, action, params });
    });
  }

  // --------------------------------------------------------------------------
  // Method handlers
  // --------------------------------------------------------------------------

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    // ── Public — anyone can call these ──────────────────────────
    "editor.open_file": (p) => sendCommand("open_file", p),
    "editor.get_selection": (p) => sendCommand("get_selection", p),
    "editor.get_active_file": (p) => sendCommand("get_active_file", p),

    // ── Internal — the shim is the only caller ──────────────────
    "editor.register": async (p) => {
      const instanceId = p.instanceId as string;
      const connectionId = ctx.connectionId;
      if (!connectionId) {
        // Shouldn't happen — register only flows in over a WS connection —
        // but guard so we don't poison `clients` with unbounded entries.
        throw new Error("editor.register requires a client connection");
      }

      // If this connection had a previous registration, evict the old one
      // first (shim restart, page reload, etc.).
      const previousInstanceId = connectionMap.get(connectionId);
      if (previousInstanceId && previousInstanceId !== instanceId) {
        clients.delete(previousInstanceId);
      }

      const client: ShimClient = {
        instanceId,
        connectionId,
        codeServerVersion: p.codeServerVersion as string | undefined,
        registeredAt: Date.now(),
      };
      clients.set(instanceId, client);
      connectionMap.set(connectionId, instanceId);

      ctx.log.info("code-server bridge registered", {
        instanceId,
        connectionId,
        codeServerVersion: client.codeServerVersion,
      });
      return { ok: true };
    },

    "editor.response": async (p) => {
      const requestId = p.requestId as string;
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        ctx.log.warn("Editor response for unknown request", { requestId });
        traceLog.warn("Unknown response", { requestId, pendingCount: pendingRequests.size });
        return { ok: false };
      }

      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);

      if (p.success) {
        traceLog.info("Command succeeded", { requestId, action: pending.action });
        pending.resolve(p.data ?? null);
      } else {
        const errorMessage = (p.error as string) || `Editor command '${pending.action}' failed`;
        traceLog.warn("Command failed", { requestId, action: pending.action, error: errorMessage });
        pending.reject(new Error(errorMessage));
      }
      return { ok: true };
    },

    "editor.notify_active_file": async (p) => {
      // Re-emit as a public event. Subscribers (chat, CLI, …) listen on this
      // name directly — they don't need to know about the shim plumbing.
      ctx.emit("editor.active_file_changed", { path: p.path });
      return { ok: true };
    },

    "editor.health_check": async (): Promise<HealthCheckResponse> => {
      const clientList = Array.from(clients.values());
      return {
        ok: clientList.length > 0,
        status: clientList.length > 0 ? "healthy" : "disconnected",
        label: "Editor (code-server bridge)",
        metrics: [
          { label: "Connected bridges", value: clientList.length },
          { label: "Pending commands", value: pendingRequests.size },
        ],
        items: clientList.map((c) => ({
          id: c.instanceId,
          label: c.codeServerVersion
            ? `code-server ${c.codeServerVersion}`
            : c.instanceId.slice(0, 8),
          status: "healthy" as const,
          details: {
            registered: new Date(c.registeredAt).toISOString(),
            connectionId: c.connectionId,
          },
        })),
      };
    },
  };

  // --------------------------------------------------------------------------
  // Extension interface
  // --------------------------------------------------------------------------

  return {
    id: "editor",
    name: "Editor (code-server bridge)",
    events: ["editor.command", "editor.active_file_changed"],
    methods: [
      // ── Public ────────────────────────────────────────────────
      {
        name: "editor.open_file",
        description: "Open a file in code-server, optionally jumping to a line/column",
        inputSchema: openFileParam,
      },
      {
        name: "editor.get_selection",
        description: "Return the active editor's current selection (text + range)",
        inputSchema: getSelectionParam,
        execution: { lane: "read", concurrency: "parallel" },
      },
      {
        name: "editor.get_active_file",
        description: "Return the path of the active editor's file, or null",
        inputSchema: getActiveFileParam,
        execution: { lane: "read", concurrency: "parallel" },
      },
      // ── Internal (shim ↔ extension) ───────────────────────────
      {
        name: "editor.register",
        description: "Register a code-server bridge client",
        inputSchema: registerParam,
        execution: { lane: "control", concurrency: "parallel" },
      },
      {
        name: "editor.response",
        description: "Deliver a response for a previously dispatched editor.command",
        inputSchema: responseParam,
        execution: { lane: "control", concurrency: "parallel" },
      },
      {
        name: "editor.notify_active_file",
        description: "Notify the extension that the active editor's file changed",
        inputSchema: notifyActiveFileParam,
        execution: { lane: "control", concurrency: "parallel" },
      },
      // ── Health ────────────────────────────────────────────────
      {
        name: "editor.health_check",
        description: "Health check",
        inputSchema: z.object({}),
        execution: { lane: "read", concurrency: "parallel" },
      },
    ],

    async start(extensionCtx) {
      ctx = extensionCtx;
      traceLog = ctx.createLogger({ component: "trace", fileName: "editor-trace.log" });

      // Drop stale shim registrations when the bridge disconnects (page
      // reload, code-server restart, etc.). Mirrors dominatrix's pattern.
      ctx.on("client.disconnected", (event) => {
        const connectionId = event.connectionId;
        if (!connectionId) return;
        const instanceId = connectionMap.get(connectionId);
        if (!instanceId) return;
        ctx.log.info("Removing disconnected code-server bridge", { connectionId, instanceId });
        clients.delete(instanceId);
        connectionMap.delete(connectionId);
      });

      ctx.log.info("Editor extension started");
    },

    async stop() {
      // Reject any in-flight commands cleanly so callers don't hang.
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Editor extension shutting down"));
        pendingRequests.delete(id);
      }
      clients.clear();
      connectionMap.clear();
      ctx.log.info("Editor extension stopped");
      traceLog = noopLogger;
    },

    async handleMethod(method, params) {
      const handler = methods[method];
      if (!handler) throw new Error(`Unknown method: ${method}`);
      return handler(params);
    },

    health() {
      return {
        ok: clients.size > 0,
        details: {
          connectedBridges: clients.size,
          pendingCommands: pendingRequests.size,
        },
      };
    },
  };
}

export default createEditorExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createEditorExtension);
