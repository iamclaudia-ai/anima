/**
 * WebSocket Extension Host
 *
 * Implements the ExtensionHost interface over a WebSocket connection.
 * Allows native apps (macOS menubar, iOS, etc.) to register as extensions
 * by connecting to the gateway's /ws endpoint and calling gateway.register_extension.
 *
 * Uses the same JSON message protocol as NDJSON hosts — the only difference
 * is transport (WebSocket frames vs. stdin/stdout lines).
 */

import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";
import type { GatewayEvent } from "@anima/shared";
import type { ExtensionHost, ExtensionRegistration, OnCallCallback } from "./extension-host";

const log = createLogger("WSExtensionHost", join(homedir(), ".anima", "logs", "gateway.log"));

const REQUEST_TIMEOUT = 300_000; // 5 min — same as NDJSON hosts

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSocketExtensionHost implements ExtensionHost {
  private pendingRequests = new Map<string, PendingRequest>();
  private registration: ExtensionRegistration;
  private generationToken: string;
  private closed = false;
  /** In-flight ctx.call() count for rate limiting */
  private inFlightCalls = 0;
  private static readonly MAX_IN_FLIGHT = 50;

  constructor(
    private extensionId: string,
    private ws: ServerWebSocket<unknown>,
    registration: ExtensionRegistration,
    private onEvent: (
      type: string,
      payload: unknown,
      source?: string,
      connectionId?: string,
      tags?: string[],
      generationToken?: string,
    ) => void,
    private onCall?: OnCallCallback,
  ) {
    this.registration = registration;
    this.generationToken = randomUUID();

    log.info("WebSocket extension host created", {
      extensionId,
      methods: registration.methods.map((m) => m.name),
      events: registration.events,
      sourceRoutes: registration.sourceRoutes,
    });
  }

  /**
   * Handle an incoming WebSocket message from the extension.
   * Called by the gateway when this connection sends a message
   * that isn't a normal client request (i.e., type is "res", "event", or "call").
   */
  handleMessage(msg: Record<string, unknown>): void {
    const msgType = msg.type as string;

    if (msgType === "res") {
      // Response to a pending request (method call result)
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
      // Extension wants to call another extension via gateway hub (ctx.call)
      this.handleCall(msg);
    } else if (msgType === "event") {
      // Extension emitted an event — forward to gateway
      this.onEvent(
        msg.event as string,
        msg.payload,
        msg.source as string | undefined,
        msg.connectionId as string | undefined,
        msg.tags as string[] | undefined,
        this.generationToken,
      );
    }
  }

  // ── ExtensionHost interface ──────────────────────────────────

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
    if (this.closed) {
      throw new Error(`WebSocket extension ${this.extensionId} is disconnected`);
    }

    const id = randomUUID();
    const timeoutMs = meta?.timeoutMs ?? REQUEST_TIMEOUT;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.send({
        type: "req",
        id,
        method,
        params,
        connectionId,
        traceId: meta?.traceId,
        depth: meta?.depth,
        deadlineMs: meta?.deadlineMs,
        timeoutMs: meta?.timeoutMs,
        tags: meta?.tags,
      });
    });
  }

  async callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callMethod("__mcpCall", { name, args });
  }

  sendEvent(event: GatewayEvent): void {
    if (this.closed) return;

    this.send({
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

  async routeToSource(source: string, event: GatewayEvent): Promise<void> {
    await this.callMethod("__sourceResponse", { source, event });
  }

  async health(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    if (this.closed) {
      return { ok: false, details: { status: "disconnected" } };
    }
    try {
      const result = (await this.callMethod("__health", {})) as {
        ok: boolean;
        details?: Record<string, unknown>;
      };
      return result;
    } catch {
      return { ok: false, details: { status: "health_check_failed" } };
    }
  }

  getRegistration(): ExtensionRegistration | null {
    return this.registration;
  }

  getGenerationToken(): string | null {
    return this.generationToken;
  }

  isRunning(): boolean {
    return !this.closed;
  }

  async kill(): Promise<void> {
    this.closed = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`WebSocket extension ${this.extensionId} disconnected`));
      this.pendingRequests.delete(id);
    }

    try {
      this.ws.close(1000, "Extension host killed");
    } catch {
      // Already closed
    }
  }

  forceKill(): void {
    this.closed = true;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();

    try {
      this.ws.close(1000, "Extension host force killed");
    } catch {
      // Already closed
    }
  }

  async restart(): Promise<ExtensionRegistration> {
    throw new Error(
      `WebSocket extension "${this.extensionId}" cannot be restarted from the gateway. ` +
        `The native app must reconnect and re-register.`,
    );
  }

  /**
   * Mark as disconnected. Called by the gateway on WebSocket close.
   * Does NOT close the WebSocket (it's already closed).
   */
  handleDisconnect(): void {
    this.closed = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`WebSocket extension ${this.extensionId} disconnected`));
      this.pendingRequests.delete(id);
    }

    log.info("WebSocket extension disconnected", { extensionId: this.extensionId });
  }

  // ── Private ──────────────────────────────────────────────────

  private send(msg: unknown): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (error) {
      log.error("Failed to send to WebSocket extension", {
        extensionId: this.extensionId,
        error: String(error),
      });
    }
  }

  /**
   * Handle a ctx.call() from the extension → route through gateway hub → send call_res back.
   */
  private async handleCall(msg: Record<string, unknown>): Promise<void> {
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
    if (this.inFlightCalls >= WebSocketExtensionHost.MAX_IN_FLIGHT) {
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

  private sendCallResponse(callId: string, ok: boolean, payloadOrError: unknown): void {
    if (ok) {
      this.send({ type: "call_res", id: callId, ok: true, payload: payloadOrError });
    } else {
      this.send({ type: "call_res", id: callId, ok: false, error: String(payloadOrError) });
    }
  }
}
