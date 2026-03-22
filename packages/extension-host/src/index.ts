#!/usr/bin/env bun
/**
 * Extension Host — runs extensions as standalone processes with NDJSON stdio.
 *
 * Extensions call `runExtensionHost(factory)` at the bottom of their index.ts:
 *
 *   import { runExtensionHost } from "@anima/extension-host";
 *   if (import.meta.main) runExtensionHost(createMyExtension);
 *
 * The gateway spawns them directly: `bun --hot extensions/my-ext/src/index.ts <config-json>`
 * With `--hot`, code changes reload the extension without restarting the process,
 * keeping stdio pipes to the gateway intact.
 */

import type { AnimaExtension, ExtensionContext, GatewayEvent } from "@anima/shared";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createLogger, matchesEventPattern } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createExtensionStore } from "./store";

// ── Types ──────────────────────────────────────────────────────

type ExtensionFactory = (config: Record<string, unknown>) => AnimaExtension;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (event: GatewayEvent) => void | Promise<void>;

// ── Public API ─────────────────────────────────────────────────

/**
 * Run an extension as a standalone process with NDJSON stdio protocol.
 *
 * Call this at the bottom of your extension's index.ts behind an
 * `import.meta.main` guard so it only runs when executed directly:
 *
 *   if (import.meta.main) runExtensionHost(createMyExtension);
 *
 * Handles: console→stderr redirect, NDJSON protocol, event bus,
 * ctx.call(), parent liveness detection, HMR lifecycle.
 */
export async function runExtensionHost(factory: ExtensionFactory): Promise<void> {
  const configJson = process.argv[2] || "{}";

  // ── Redirect console to stderr ──────────────────────────────
  // stdout is reserved for NDJSON protocol. The shared logger writes to
  // both console AND file, so we redirect console.log/warn/error to stderr.
  const stderrWrite = (msg: string) => process.stderr.write(msg + "\n");
  console.log = (...args: unknown[]) => stderrWrite(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => stderrWrite(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderrWrite(args.map(String).join(" "));

  const hostLog = createLogger(
    "ExtensionHost",
    join(homedir(), ".anima", "logs", "extension-host.log"),
  );

  // ── Parent liveness check ───────────────────────────────────
  // When bun --watch restarts the gateway, orphan extension hosts get
  // reparented to PID 1 (launchd). Poll to detect this and self-terminate.
  const parentPidAtStart = process.ppid;
  const parentCheckInterval = setInterval(() => {
    if (process.ppid !== parentPidAtStart) {
      hostLog.info(`Parent PID changed (${parentPidAtStart} → ${process.ppid}), shutting down`);
      clearInterval(parentCheckInterval);
      process.exit(0);
    }
  }, 2000);

  // ── NDJSON I/O ──────────────────────────────────────────────

  function write(msg: unknown): void {
    const line = JSON.stringify(msg);
    process.stdout.write(line + "\n");
  }

  function writeEvent(
    type: string,
    payload: unknown,
    options?: { source?: string; connectionId?: string; tags?: string[] },
  ): void {
    write({
      type: "event",
      event: type,
      payload,
      source: options?.source,
      connectionId: options?.connectionId ?? currentConnectionId,
      tags: options?.tags ?? currentTags,
    });
  }

  function writeResponse(id: string, ok: boolean, payload: unknown): void {
    if (ok) {
      write({ type: "res", id, ok: true, payload });
    } else {
      write({ type: "res", id, ok: false, error: String(payload) });
    }
  }

  // ── Pending Calls (ctx.call → gateway hub) ──────────────────

  const pendingCalls = new Map<string, PendingCall>();
  const CALL_TIMEOUT = 300_000; // 5 min

  // Current call context — set per inbound request from gateway
  let currentConnectionId: string | null = null;
  let currentTags: string[] | null = null;
  let currentTraceId: string | null = null;
  let currentDepth = 0;
  let currentDeadlineMs: number | null = null;

  // ── Event Bus ───────────────────────────────────────────────

  const eventHandlers = new Map<string, Set<EventHandler>>();
  let _debugEventSeq = 0;

  async function broadcastToHandlers(event: GatewayEvent): Promise<void> {
    const handlers: EventHandler[] = [];
    for (const [pattern, handlerSet] of eventHandlers) {
      if (matchesEventPattern(event.type, pattern)) {
        handlers.push(...handlerSet);
      }
    }
    // Debug: log event delivery to trace duplication
    if (event.type.includes("content_block_start") || event.type.includes("message_stop")) {
      _debugEventSeq++;
      hostLog.info("EVENT_DEBUG", {
        seq: _debugEventSeq,
        type: event.type,
        conn: event.connectionId?.slice(0, 8),
        handlers: handlers.length,
        patterns: Array.from(eventHandlers.keys()),
      });
    }
    await Promise.all(handlers.map((h) => h(event)));
  }

  // ── Extension Loading ───────────────────────────────────────

  let extension: AnimaExtension | null = null;

  async function loadAndStart(): Promise<AnimaExtension> {
    const config = JSON.parse(configJson);
    const ext = factory(config);

    hostLog.info("Starting extension", { id: ext.id, name: ext.name });

    // Create extension context — bridges events to/from stdio
    const ctx: ExtensionContext = {
      on(pattern: string, handler: EventHandler): () => void {
        if (!eventHandlers.has(pattern)) {
          eventHandlers.set(pattern, new Set());
        }
        eventHandlers.get(pattern)!.add(handler);
        return () => {
          eventHandlers.get(pattern)?.delete(handler);
        };
      },

      emit(
        type: string,
        payload: unknown,
        options?: { source?: string; connectionId?: string; tags?: string[] },
      ): void {
        writeEvent(type, payload, options);
      },

      async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
        const id = randomUUID();
        const now = Date.now();
        let deadlineMs = currentDeadlineMs;
        if (!deadlineMs) {
          deadlineMs = now + CALL_TIMEOUT;
        }
        const remaining = deadlineMs - now;
        if (remaining <= 0) {
          throw new Error(`Call deadline exceeded before sending ${method}`);
        }

        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              pendingCalls.delete(id);
              reject(
                new Error(
                  `ctx.call(${method}) timed out after ${Math.min(remaining, CALL_TIMEOUT)}ms`,
                ),
              );
            },
            Math.min(remaining, CALL_TIMEOUT),
          );

          pendingCalls.set(id, { resolve, reject, timer });

          write({
            type: "call",
            id,
            method,
            params: params ?? {},
            connectionId: currentConnectionId,
            tags: currentTags,
            traceId: currentTraceId || randomUUID(),
            depth: currentDepth + 1,
            deadlineMs,
          });
        });
      },

      get connectionId(): string | null {
        return currentConnectionId;
      },

      get tags(): string[] | null {
        return currentTags;
      },

      config,

      log: createLogger(ext.id, join(homedir(), ".anima", "logs", `${ext.id}.log`)),

      store: createExtensionStore(ext.id),
    };

    // Register first — makes methods available to other extensions immediately.
    // start() runs after, so extensions can set up ctx.on() handlers for
    // gateway.extensions_ready without worrying about load order.
    const methods = ext.methods.map((m) => {
      let inputSchema: unknown;
      try {
        inputSchema = zodToJsonSchema(m.inputSchema, m.name);
      } catch {
        inputSchema = m.inputSchema._def; // fallback to raw Zod _def
      }
      return { name: m.name, description: m.description, inputSchema };
    });

    write({
      type: "register",
      extension: {
        id: ext.id,
        name: ext.name,
        methods,
        events: ext.events,
        sourceRoutes: ext.sourceRoutes || [],
      },
    });

    hostLog.info("Extension registered", { id: ext.id });

    await ext.start(ctx);

    hostLog.info("Extension started", { id: ext.id });

    return ext;
  }

  // ── Message Handler ─────────────────────────────────────────

  async function handleMessage(line: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      hostLog.warn("Invalid JSON on stdin", { line: line.slice(0, 100) });
      return;
    }

    if (msg.type === "req") {
      const id = msg.id as string;
      const method = msg.method as string;
      const params = (msg.params as Record<string, unknown>) || {};

      // Set per-request context from envelope
      const prevConnectionId = currentConnectionId;
      const prevTags = currentTags;
      const prevTraceId = currentTraceId;
      const prevDepth = currentDepth;
      const prevDeadlineMs = currentDeadlineMs;
      currentConnectionId = (msg.connectionId as string) || null;
      currentTags = (msg.tags as string[]) || null;
      currentTraceId = (msg.traceId as string) || null;
      currentDepth = (msg.depth as number) || 0;
      currentDeadlineMs = (msg.deadlineMs as number) || null;

      const restoreContext = () => {
        currentConnectionId = prevConnectionId;
        currentTags = prevTags;
        currentTraceId = prevTraceId;
        currentDepth = prevDepth;
        currentDeadlineMs = prevDeadlineMs;
      };

      if (!extension) {
        writeResponse(id, false, "Extension not loaded");
        restoreContext();
        return;
      }

      // Special internal methods
      if (method === "__health") {
        writeResponse(id, true, extension.health());
        restoreContext();
        return;
      }

      if (method === "__sourceResponse") {
        const source = params.source as string;
        const event = params.event as GatewayEvent;
        if (extension.handleSourceResponse) {
          try {
            await extension.handleSourceResponse(source, event);
            writeResponse(id, true, { status: "ok" });
          } catch (error) {
            writeResponse(id, false, String(error));
          }
        } else {
          writeResponse(id, false, "Extension does not handle source responses");
        }
        restoreContext();
        return;
      }

      // Regular method call
      try {
        const result = await extension.handleMethod(method, params);
        writeResponse(id, true, result);
      } catch (error) {
        writeResponse(id, false, String(error));
      }

      restoreContext();
    } else if (msg.type === "call_res") {
      const id = msg.id as string;
      const pending = pendingCalls.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCalls.delete(id);
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error(msg.error as string));
        }
      }
    } else if (msg.type === "event") {
      const event: GatewayEvent = {
        type: msg.event as string,
        payload: msg.payload,
        timestamp: Date.now(),
        origin: msg.origin as string | undefined,
        source: msg.source as string | undefined,
        sessionId: msg.sessionId as string | undefined,
        connectionId: msg.connectionId as string | undefined,
        tags: (msg.tags as string[]) || undefined,
      };
      // Set context so any ctx.emit() during handler gets the right connectionId + tags
      const prevConnectionId = currentConnectionId;
      const prevTags = currentTags;
      currentConnectionId = event.connectionId || null;
      currentTags = event.tags || null;
      await broadcastToHandlers(event);
      currentConnectionId = prevConnectionId;
      currentTags = prevTags;
    }
  }

  // Store handleMessage in hot data so persisted stdin listener can find the latest version
  if (import.meta.hot) {
    import.meta.hot.data.handleMessage = handleMessage;
  }

  // ── Stdin Reading ───────────────────────────────────────────
  // IMPORTANT: Only attach listeners once — they persist across HMR reloads
  // since process.stdin is the same object. We defensively remove all existing
  // listeners before attaching to prevent stacking across HMR cycles.

  function readStdin(): void {
    // Defensively remove ALL existing listeners to prevent stacking.
    // HMR reloads can cause multiple registrations if the guard flag
    // doesn't survive properly — belt AND suspenders.
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("end");
    process.stdin.removeAllListeners("error");

    // Preserve buffer across HMR reloads so partial lines aren't lost
    let buffer = import.meta.hot?.data?.stdinBuffer ?? "";

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", async (chunk: string) => {
      buffer += chunk;
      if (import.meta.hot) {
        import.meta.hot.data.stdinBuffer = buffer;
      }

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (import.meta.hot) {
          import.meta.hot.data.stdinBuffer = buffer;
        }

        if (line.length > 0) {
          // Use latest handler from hot data (survives HMR reloads)
          const handler = import.meta.hot?.data?.handleMessage || handleMessage;
          await handler(line);
        }
      }
    });

    process.stdin.on("end", async () => {
      hostLog.info("Stdin closed, shutting down");
      const ext = import.meta.hot?.data?.extension || extension;
      if (ext) {
        await ext.stop();
      }
      process.exit(0);
    });

    process.stdin.on("error", (error: Error) => {
      hostLog.error("Stdin error", { error: String(error) });
    });

    process.stdin.resume();
  }

  // ── Start ───────────────────────────────────────────────────

  try {
    extension = await loadAndStart();
    if (import.meta.hot) {
      import.meta.hot.data.extension = extension;
    }
    const isHmrReload = import.meta.hot?.data?.stdinInitialized === true;
    if (isHmrReload) {
      hostLog.info("Extension hot-reloaded successfully", {
        id: extension.id,
        name: extension.name,
      });
    }
    if (import.meta.hot) {
      import.meta.hot.data.stdinInitialized = true;
    }
    readStdin();
  } catch (error) {
    hostLog.error("Failed to start extension", { error: String(error) });
    write({ type: "error", error: String(error) });
    process.exit(1);
  }

  // ── HMR ─────────────────────────────────────────────────────

  if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
      hostLog.info("HMR: disposing extension", { id: extension?.id });
      if (extension) {
        await extension.stop();
        extension = null;
      }
      eventHandlers.clear();
      for (const [id, pending] of pendingCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension reloading (HMR)"));
        pendingCalls.delete(id);
      }
      clearInterval(parentCheckInterval);
    });
  }
}
