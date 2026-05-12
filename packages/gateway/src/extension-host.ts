/**
 * Extension Host Process
 *
 * Manages a single out-of-process extension via stdio NDJSON.
 * Mirrors the RuntimeSession pattern for spawning + communicating with child processes.
 *
 * The gateway spawns one of these per enabled extension.
 */

import { spawn, type Subprocess } from "bun";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";
import type { GatewayEvent, WebStaticPath } from "@anima/shared";

const log = createLogger("ExtensionHost", join(homedir(), ".anima", "logs", "gateway.log"));

/** Serialized method info from the host's register message (no Zod schemas) */
interface RemoteMethodInfo {
  name: string;
  description: string;
}

/** Serialized MCP tool info from the host's register message */
export interface RemoteMcpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Registration data sent by the host after extension.start() */
export interface ExtensionRegistration {
  id: string;
  name: string;
  methods: RemoteMethodInfo[];
  mcpTools?: RemoteMcpToolInfo[];
  events: string[];
  sourceRoutes: string[];
  /** Static URL paths the extension wants the gateway to serve. */
  webStatic?: WebStaticPath[];
}

/**
 * Transport-agnostic interface for extension hosts.
 *
 * Both NDJSON (child process) and WebSocket hosts implement this.
 * The ExtensionManager routes through this interface — it doesn't
 * care whether the extension is a local Bun process or a remote
 * native app connected over WebSocket.
 */
export interface ExtensionHost {
  callMethod(
    method: string,
    params: Record<string, unknown>,
    connectionId?: string,
    meta?: {
      traceId?: string;
      depth?: number;
      deadlineMs?: number;
      timeoutMs?: number;
      tags?: string[];
    },
  ): Promise<unknown>;

  callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown>;

  sendEvent(event: GatewayEvent): void;

  routeToSource(source: string, event: GatewayEvent): Promise<void>;

  health(): Promise<{ ok: boolean; details?: Record<string, unknown> }>;

  getRegistration(): ExtensionRegistration | null;

  getGenerationToken(): string | null;

  isRunning(): boolean;

  kill(): Promise<void>;

  forceKill(): void;

  restart(): Promise<ExtensionRegistration>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT = 300_000; // 5 min — extensions like memory.process do serial LLM calls
const RESTART_DELAY = 2_000;
const MAX_RESTARTS = 5;

// Resolve bun executable — use the same binary that's running this process
// so it works correctly when launched from launchd without a full shell PATH.
const BUN_BIN = process.execPath;

/** Callback for handling ctx.call() from extensions */
export type OnCallCallback = (
  callerExtensionId: string,
  method: string,
  params: Record<string, unknown>,
  meta: {
    connectionId?: string;
    tags?: string[];
    traceId?: string;
    depth?: number;
    deadlineMs?: number;
  },
) => Promise<{ ok: true; payload: unknown } | { ok: false; error: string }>;

export class ExtensionHostProcess implements ExtensionHost {
  private proc: Subprocess | null = null;
  private stdoutBuffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  private registration: ExtensionRegistration | null = null;
  private registrationResolve: ((reg: ExtensionRegistration) => void) | null = null;
  private restartCount = 0;
  private killed = false;
  /** In-flight ctx.call() count for rate limiting */
  private inFlightCalls = 0;
  private static readonly MAX_IN_FLIGHT = 50;
  /** Monotonic counter to distinguish stale exit callbacks from current process */
  private spawnGeneration = 0;
  /** Token for current process generation, used to drop stale events/responses */
  private generationToken: string | null = null;

  constructor(
    private extensionId: string,
    private moduleSpec: string,
    private config: Record<string, unknown>,
    private onEvent: (
      type: string,
      payload: unknown,
      source?: string,
      connectionId?: string,
      tags?: string[],
      generationToken?: string,
    ) => void,
    private onRegister: (registration: ExtensionRegistration, generationToken?: string) => void,
    private onCall?: OnCallCallback,
    private hot: boolean = false,
  ) {}

  /**
   * Spawn the extension host process and wait for registration.
   */
  async spawn(): Promise<ExtensionRegistration> {
    const configJson = JSON.stringify(this.config);
    this.registration = null;
    const generationToken = randomUUID();
    this.generationToken = generationToken;

    log.info("Spawning extension host", {
      extensionId: this.extensionId,
      module: this.moduleSpec,
    });

    const cmd = this.hot
      ? [BUN_BIN, "--hot", this.moduleSpec, configJson]
      : [BUN_BIN, "run", this.moduleSpec, configJson];

    log.info("Extension spawn mode", { id: this.extensionId, hot: this.hot });

    this.proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: join(import.meta.dir, "..", "..", ".."), // project root
    });

    this.stdoutBuffer = "";

    if (this.proc.stdout && typeof this.proc.stdout !== "number") {
      this.readStdout(this.proc.stdout, generationToken);
    }
    if (this.proc.stderr && typeof this.proc.stderr !== "number") {
      this.readStderr(this.proc.stderr, generationToken);
    }

    // Capture spawn generation so handleExit can ignore stale exits
    // from a previous process after restart() has already spawned a new one.
    const generation = ++this.spawnGeneration;
    this.proc.exited.then((exitCode) => this.handleExit(exitCode, generation));

    // Wait for the register message
    return new Promise<ExtensionRegistration>((resolve, reject) => {
      this.registrationResolve = resolve;

      // Timeout if host doesn't register in time
      setTimeout(() => {
        if (!this.registration) {
          reject(new Error(`Extension host ${this.extensionId} failed to register within 10s`));
        }
      }, 10_000);
    });
  }

  /**
   * Call a method on the extension. Returns a promise that resolves with the result.
   */
  async callMethod(
    method: string,
    params: Record<string, unknown>,
    connectionId?: string,
    meta?: {
      traceId?: string;
      depth?: number;
      deadlineMs?: number;
      timeoutMs?: number;
      tags?: string[];
    },
  ): Promise<unknown> {
    return this.sendRequest(method, params, connectionId, meta);
  }

  async callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest("__mcpCall", { name, args });
  }

  /**
   * Forward an event to the extension host (so extension handlers can process it).
   */
  sendEvent(event: GatewayEvent): void {
    this.writeToStdin({
      type: "event",
      event: event.type,
      payload: event.payload,
      origin: event.origin,
      source: event.source,
      sessionId: event.sessionId,
      connectionId: event.connectionId,
      tags: event.tags,
    });
  }

  /**
   * Route a source response to the extension.
   */
  async routeToSource(source: string, event: GatewayEvent): Promise<void> {
    await this.sendRequest("__sourceResponse", { source, event });
  }

  /**
   * Get the extension's health status.
   */
  async health(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    if (!this.proc) {
      return { ok: false, details: { status: "not_running" } };
    }
    try {
      const result = (await this.sendRequest("__health", {})) as {
        ok: boolean;
        details?: Record<string, unknown>;
      };
      return result;
    } catch {
      return { ok: false, details: { status: "health_check_failed" } };
    }
  }

  /**
   * Get the registration info (methods, events, source routes).
   */
  getRegistration(): ExtensionRegistration | null {
    return this.registration;
  }

  getGenerationToken(): string | null {
    return this.generationToken;
  }

  /**
   * Whether the process is currently running.
   */
  isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Kill the host process. Used during gateway shutdown.
   */
  async kill(): Promise<void> {
    this.killed = true;
    if (this.proc) {
      const exitPromise = this.proc.exited;
      // Close stdin first — the host process exits cleanly when stdin closes
      try {
        const stdin = this.proc.stdin;
        if (stdin && typeof stdin !== "number") {
          (stdin as unknown as { close?: () => void }).close?.();
        }
      } catch {
        // Ignore stdin close errors
      }
      this.proc.kill("SIGTERM");
      this.proc = null;
      // Wait for the process to fully exit (with 5s timeout as safety net).
      // The spawnGeneration guard in handleExit is the primary protection
      // against stale exit callbacks — this await is a best-effort cleanup.
      try {
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
      } catch {
        // Process may already be dead
      }
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Extension host killed"));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Kill and re-spawn the extension host process (manual HMR).
   * Resets the restart counter so auto-restart logic starts fresh.
   */
  async restart(): Promise<ExtensionRegistration> {
    log.info("Restarting extension host", { extensionId: this.extensionId });
    await this.kill();
    this.killed = false;
    this.restartCount = 0;
    return this.spawn();
  }

  /**
   * Synchronous force-kill (for process "exit" handler where async isn't possible).
   */
  forceKill(): void {
    this.killed = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
      this.proc = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    connectionId?: string,
    meta?: {
      traceId?: string;
      depth?: number;
      deadlineMs?: number;
      timeoutMs?: number;
      tags?: string[];
    },
  ): Promise<unknown> {
    if (!this.proc) {
      throw new Error(`Extension host ${this.extensionId} is not running`);
    }

    const id = randomUUID();
    const timeoutMs = meta?.timeoutMs ?? REQUEST_TIMEOUT;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.writeToStdin({
        type: "req",
        id,
        method,
        params,
        connectionId,
        traceId: meta?.traceId,
        depth: meta?.depth,
        deadlineMs: meta?.deadlineMs,
        tags: meta?.tags,
      });
    });
  }

  private writeToStdin(msg: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") {
      log.warn("Cannot write to extension host stdin", { extensionId: this.extensionId });
      return;
    }

    try {
      stdin.write(JSON.stringify(msg) + "\n");
    } catch (error) {
      log.error("Failed to write to extension host stdin", {
        extensionId: this.extensionId,
        error: String(error),
      });
    }
  }

  private async readStdout(
    stdout: ReadableStream<Uint8Array>,
    generationToken: string,
  ): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.stdoutBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        // String.indexOf newline scan — not an array lookup.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

          if (line.length > 0) {
            this.handleLine(line, generationToken);
          }
        }
      }
    } catch {
      // Stream closed — process exited
    }
  }

  private async readStderr(
    stderr: ReadableStream<Uint8Array>,
    generationToken: string,
  ): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          log.warn(`[${this.extensionId}] stderr`, { text: text.trim().substring(0, 500) });
        }
      }
    } catch {
      // Stream closed
    }
  }

  private handleLine(line: string, generationToken?: string): void {
    if (generationToken && this.generationToken && this.generationToken !== generationToken) {
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn("Invalid JSON from extension host", {
        extensionId: this.extensionId,
        line: line.slice(0, 100),
      });
      return;
    }

    const msgType = msg.type as string;

    if (msgType === "register") {
      // Extension registered — store metadata and notify gateway
      this.registration = msg.extension as ExtensionRegistration;
      log.info("Extension registered", {
        id: this.registration.id,
        name: this.registration.name,
        methods: this.registration.methods.map((m) => m.name),
      });
      this.onRegister(this.registration, generationToken);
      if (this.registrationResolve) {
        this.registrationResolve(this.registration);
        this.registrationResolve = null;
      }
    } else if (msgType === "res") {
      // Response to a pending request
      const id = msg.id as string;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error(msg.error as string));
        }
      }
    } else if (msgType === "call") {
      // Extension wants to call another extension via gateway hub
      this.handleCall(msg, generationToken);
    } else if (msgType === "event") {
      // Extension emitted an event — forward to gateway (with envelope metadata)
      this.onEvent(
        msg.event as string,
        msg.payload,
        msg.source as string | undefined,
        msg.connectionId as string | undefined,
        msg.tags as string[] | undefined,
        generationToken,
      );
    } else if (msgType === "error") {
      // Fatal error from host
      log.error("Extension host error", {
        extensionId: this.extensionId,
        error: msg.error,
      });
    }
  }

  /**
   * Handle a ctx.call() from the extension → route through gateway hub → send call_res back.
   */
  private async handleCall(msg: Record<string, unknown>, generationToken?: string): Promise<void> {
    if (generationToken && this.generationToken && this.generationToken !== generationToken) {
      return;
    }

    const callId = msg.id as string;
    const method = msg.method as string;
    const params = (msg.params as Record<string, unknown>) || {};
    const depth = (msg.depth as number) || 0;
    const traceId = (msg.traceId as string) || randomUUID();
    const deadlineMs = msg.deadlineMs as number | undefined;
    const tags = msg.tags as string[] | undefined;

    // Guardrail: max depth
    if (depth > 8) {
      this.sendCallResponse(callId, false, `Call depth ${depth} exceeds max (8) — possible cycle`);
      return;
    }

    // Guardrail: deadline exceeded
    if (deadlineMs && Date.now() > deadlineMs) {
      this.sendCallResponse(callId, false, `Call deadline exceeded for ${method}`);
      return;
    }

    // Guardrail: per-extension in-flight cap
    if (this.inFlightCalls >= ExtensionHostProcess.MAX_IN_FLIGHT) {
      this.sendCallResponse(
        callId,
        false,
        `Extension ${this.extensionId} busy — ${this.inFlightCalls} calls in flight`,
      );
      return;
    }

    if (!this.onCall) {
      this.sendCallResponse(
        callId,
        false,
        "ctx.call not supported — no onCall callback registered",
      );
      return;
    }

    this.inFlightCalls++;
    const startTime = Date.now();

    try {
      const result = await this.onCall(this.extensionId, method, params, {
        connectionId: msg.connectionId as string | undefined,
        tags,
        traceId,
        depth,
        deadlineMs,
      });
      if (result.ok) {
        this.sendCallResponse(callId, true, result.payload);
      } else {
        this.sendCallResponse(callId, false, result.error);
      }
    } catch (error) {
      this.sendCallResponse(callId, false, String(error));
    } finally {
      this.inFlightCalls--;
      const duration = Date.now() - startTime;
      log.info("ctx.call completed", {
        traceId,
        caller: this.extensionId,
        method,
        depth,
        durationMs: duration,
      });
    }
  }

  /**
   * Send a call_res back to the extension host process.
   */
  private sendCallResponse(callId: string, ok: boolean, payloadOrError: unknown): void {
    if (ok) {
      this.writeToStdin({ type: "call_res", id: callId, ok: true, payload: payloadOrError });
    } else {
      this.writeToStdin({ type: "call_res", id: callId, ok: false, error: String(payloadOrError) });
    }
  }

  private handleExit(exitCode: number | null, generation: number): void {
    // Ignore stale exit callbacks from a previous spawn.
    // After restart(), the old process's .exited promise resolves AFTER
    // killed is reset to false and a new process is spawned. Without this
    // guard, the stale callback sees killed=false and triggers auto-restart,
    // creating duplicate processes.
    if (generation !== this.spawnGeneration) {
      log.info("Ignoring stale exit callback", {
        extensionId: this.extensionId,
        exitCode,
        generation,
        currentGeneration: this.spawnGeneration,
      });
      return;
    }

    log.info("Extension host exited", {
      extensionId: this.extensionId,
      exitCode,
      killed: this.killed,
      generation,
    });

    this.proc = null;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Extension host ${this.extensionId} exited with code ${exitCode}`));
      this.pendingRequests.delete(id);
    }

    // Auto-restart unless we were explicitly killed
    if (!this.killed && this.restartCount < MAX_RESTARTS) {
      this.restartCount++;
      log.info("Auto-restarting extension host", {
        extensionId: this.extensionId,
        attempt: this.restartCount,
        maxRestarts: MAX_RESTARTS,
        delayMs: RESTART_DELAY,
      });
      setTimeout(() => {
        this.spawn().catch((error) => {
          log.error("Failed to restart extension host", {
            extensionId: this.extensionId,
            error: String(error),
          });
        });
      }, RESTART_DELAY);
    } else if (!this.killed) {
      log.error("Extension host exceeded max restarts", {
        extensionId: this.extensionId,
        maxRestarts: MAX_RESTARTS,
      });
    }
  }
}
