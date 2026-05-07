/**
 * Minimal Anima gateway WebSocket client for the code-server bridge.
 *
 * Mirrors the dominatrix Chrome client: connect with a token query param,
 * subscribe exclusively to `editor.command`, register, then dispatch
 * incoming commands and reply via `editor.response`. Auto-reconnect with
 * a fixed backoff. `client.disconnected` cleanup is handled server-side
 * — when the WS drops, the editor extension drops our registration.
 */

import WebSocket, { type RawData } from "ws";
import { randomUUID } from "node:crypto";

export type CommandHandler = (action: string, params: Record<string, unknown>) => Promise<unknown>;

export interface GatewayClientOptions {
  /** Absolute WS URL of the gateway, e.g. `wss://anima.example.com/ws`. */
  url: string;
  /** Bearer token that matches `gateway.token` in anima.json. */
  token: string;
  /** Stable instance ID for this shim (persisted across reloads). */
  instanceId: string;
  /** Reported alongside `editor.register` for the health card. */
  codeServerVersion?: string;
  /** Called when a `editor.command` event arrives. Returned value is the response data. */
  onCommand: CommandHandler;
  /** Called whenever the connection state flips (UI indicator etc). */
  onStateChange?: (state: ConnectionState) => void;
  /** Console.log-compatible logger; defaults to a no-op. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Reconnect delay in ms (default 3000). */
  reconnectDelayMs?: number;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

export class GatewayClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly opts: Required<
    Omit<GatewayClientOptions, "codeServerVersion" | "onStateChange" | "log">
  > &
    Pick<GatewayClientOptions, "codeServerVersion" | "onStateChange" | "log">;

  constructor(opts: GatewayClientOptions) {
    this.opts = {
      reconnectDelayMs: 3000,
      ...opts,
    };
  }

  start(): void {
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best-effort
      }
      this.ws = null;
    }
    this.setState("disconnected");
  }

  /**
   * Force a reconnect — used by the user-facing "Anima: Reconnect Bridge"
   * command. Tear down any open socket; the close handler will schedule a
   * fresh connect.
   */
  reconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best-effort
      }
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.disposed) this.connect();
  }

  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Send a fire-and-forget request to the gateway. Used for emitting events
   * back to the extension (`editor.notify_active_file`) without waiting for a
   * payload — gateway always responds, but we have nothing to do with it.
   */
  send(method: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "req",
        id: randomUUID(),
        method,
        params,
      }),
    );
  }

  // ── internals ──────────────────────────────────────────────

  private buildUrl(): string {
    if (!this.opts.token) return this.opts.url;
    const sep = this.opts.url.includes("?") ? "&" : "?";
    return `${this.opts.url}${sep}token=${encodeURIComponent(this.opts.token)}`;
  }

  private connect(): void {
    if (this.disposed) return;
    this.setState("connecting");
    const url = this.buildUrl();
    this.opts.log?.("connecting", { authenticated: url.includes("token=") });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.opts.log?.("connect threw", { error: String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.opts.log?.("connected");
      this.setState("connected");
      // Subscribe exclusively — last subscriber wins, so a second code-server
      // tab steals command handling rather than fighting for it.
      this.send("gateway.subscribe", {
        events: ["editor.command"],
        exclusive: true,
      });
      this.send("editor.register", {
        instanceId: this.opts.instanceId,
        codeServerVersion: this.opts.codeServerVersion,
      });
    });

    ws.on("message", (data: RawData) => {
      this.handleMessage(data.toString());
    });

    ws.on("error", (err: Error) => {
      this.opts.log?.("ws error", { error: err.message });
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.opts.log?.("ws closed", { code, reason: reason.toString() });
      this.ws = null;
      this.setState("disconnected");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.opts.reconnectDelayMs);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: { type?: string; id?: string; event?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      this.opts.log?.("bad json from gateway", { error: String(err) });
      return;
    }

    // Reply to the gateway's heartbeat ping immediately or it will close us.
    if (msg.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong", id: msg.id }));
      return;
    }

    if (msg.type !== "event" || msg.event !== "editor.command") return;

    const payload = (msg.payload || {}) as {
      requestId?: string;
      action?: string;
      params?: Record<string, unknown>;
    };
    const { requestId, action, params } = payload;
    if (!requestId || !action) return;

    try {
      const data = await this.opts.onCommand(action, params ?? {});
      this.send("editor.response", { requestId, success: true, data });
    } catch (err) {
      this.send("editor.response", {
        requestId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
