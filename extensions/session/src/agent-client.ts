/**
 * Agent Host Client — WebSocket client for the agent-host server.
 *
 * Thin RPC client that translates session operations into WebSocket messages
 * to the agent-host server. Replaces direct SessionManager usage when
 * agent-host mode is enabled.
 *
 * Features:
 * - Request/response RPC over WebSocket
 * - Session event streaming (emits "session.event" like SessionManager)
 * - Auto-reconnect with exponential backoff
 * - Event replay on reconnection (gap-free streaming)
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createLogger } from "@anima/shared";
import type {
  AgentHostClientMessage as ClientMessage,
  AgentHostResponseMessage as ResponseMessage,
  AgentHostSessionEventMessage as SessionEventMessage,
  AgentHostTaskEventMessage as TaskEventMessage,
} from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("AgentClient", join(homedir(), ".anima", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── AgentHostClient ──────────────────────────────────────────

export class AgentHostClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private lastSeenSeq = new Map<string, number>();
  private lastSeenTaskSeq = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectBackoff = 1000;
  private isConnecting = false;
  private _isConnected = false;

  private url: string;
  private extensionId: string;

  private static readonly REQUEST_TIMEOUT = 30_000;
  private static readonly MAX_RECONNECT_BACKOFF = 10_000;

  constructor(url: string, extensionId = "session") {
    super();
    this.url = url;
    this.extensionId = extensionId;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  // ── Connection Management ──────────────────────────────────

  /**
   * Connect to the agent-host server.
   * Sends auth message with resume sessions for reconnection replay.
   */
  async connect(): Promise<void> {
    if (this._isConnected || this.isConnecting) return;
    this.isConnecting = true;

    return new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(this.url);

        ws.onopen = () => {
          this.ws = ws;
          this._isConnected = true;
          this.isConnecting = false;
          this.reconnectBackoff = 1000;

          // Send auth with resume sessions
          const resumeSessions = Array.from(this.lastSeenSeq.entries()).map(
            ([sessionId, lastSeq]) => ({ sessionId, lastSeq }),
          );
          const resumeTasks = Array.from(this.lastSeenTaskSeq.entries()).map(
            ([taskId, lastSeq]) => ({
              taskId,
              lastSeq,
            }),
          );

          const authMsg: ClientMessage = {
            type: "auth",
            extensionId: this.extensionId,
            ...(resumeSessions.length > 0 ? { resumeSessions } : {}),
            ...(resumeTasks.length > 0 ? { resumeTasks } : {}),
          };

          ws.send(JSON.stringify(authMsg));
          log.info("Connected to agent-host", {
            url: this.url,
            resumeSessions: resumeSessions.length,
          });
          resolve();
        };

        ws.onmessage = (event) => {
          this.handleMessage(typeof event.data === "string" ? event.data : String(event.data));
        };

        ws.onclose = () => {
          const wasConnected = this._isConnected;
          const wasConnecting = this.isConnecting;
          this._isConnected = false;
          this.ws = null;
          this.isConnecting = false;

          if (wasConnecting && !wasConnected) {
            // Socket closed before onopen fired — reject the connection promise
            reject(new Error(`Connection closed before open: ${this.url}`));
          } else if (wasConnected) {
            log.warn("Disconnected from agent-host, scheduling reconnect");
            this.scheduleReconnect();
          }
        };

        ws.onerror = (error) => {
          log.error("WebSocket error", { error: String(error) });
          if (this.isConnecting) {
            this.isConnecting = false;
            reject(new Error(`Failed to connect to agent-host at ${this.url}`));
          }
        };
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the agent-host server.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this._isConnected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Disconnected from agent-host"));
      this.pendingRequests.delete(id);
    }
  }

  // ── RPC Methods ────────────────────────────────────────────

  /**
   * Create a new session on the agent-host.
   */
  async createSession(params: {
    sessionId?: string;
    cwd: string;
    model?: string;
    systemPrompt?: string;
    thinking?: boolean;
    effort?: string;
    agent?: string;
  }): Promise<{ sessionId: string }> {
    const result = await this.sendRequest({
      type: "session.create",
      requestId: "",
      params,
    });
    return result as { sessionId: string };
  }

  /**
   * Send a prompt to a session.
   */
  async prompt(
    sessionId: string,
    content: string | unknown[],
    cwd?: string,
    model?: string,
    agent?: string,
  ): Promise<void> {
    await this.sendRequest({
      type: "session.prompt",
      requestId: "",
      sessionId,
      content,
      cwd,
      model,
      agent,
    });
  }

  /**
   * Interrupt a session.
   */
  async interrupt(sessionId: string): Promise<boolean> {
    const result = (await this.sendRequest({
      type: "session.interrupt",
      requestId: "",
      sessionId,
    })) as { ok?: boolean } | undefined;
    return result?.ok !== false;
  }

  /**
   * Close a session.
   */
  async close(sessionId: string): Promise<void> {
    await this.sendRequest({
      type: "session.close",
      requestId: "",
      sessionId,
    });
    this.lastSeenSeq.delete(sessionId);
  }

  /**
   * List active sessions.
   */
  async list(): Promise<unknown[]> {
    const result = await this.sendRequest({
      type: "session.list",
      requestId: "",
    });
    return (result as unknown[]) || [];
  }

  async startTask(params: {
    sessionId: string;
    agent: string;
    prompt: string;
    mode?: "general" | "review" | "test";
    cwd?: string;
    worktree?: boolean;
    continue?: string;
    model?: string;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    files?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{
    taskId: string;
    status: string;
    outputFile?: string;
    message: string;
    cwd?: string;
    worktreePath?: string;
    parentRepoPath?: string;
    continuedFromTaskId?: string;
  }> {
    const result = await this.sendRequest({
      type: "task.start",
      requestId: "",
      params,
    });
    return result as {
      taskId: string;
      status: string;
      outputFile?: string;
      message: string;
      cwd?: string;
      worktreePath?: string;
      parentRepoPath?: string;
      continuedFromTaskId?: string;
    };
  }

  async getTask(taskId: string): Promise<unknown> {
    const result = await this.sendRequest({
      type: "task.get",
      requestId: "",
      taskId,
    });
    return result;
  }

  async listTasks(filters?: {
    sessionId?: string;
    status?: "running" | "completed" | "failed" | "interrupted";
    agent?: string;
  }): Promise<unknown> {
    const result = await this.sendRequest({
      type: "task.list",
      requestId: "",
      ...filters,
    });
    return result;
  }

  async interruptTask(taskId: string): Promise<boolean> {
    const result = (await this.sendRequest({
      type: "task.interrupt",
      requestId: "",
      taskId,
    })) as { ok?: boolean } | undefined;
    return result?.ok !== false;
  }

  /**
   * Set permission mode for a session.
   */
  async setPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    const result = (await this.sendRequest({
      type: "session.set_permission_mode",
      requestId: "",
      sessionId,
      mode,
    })) as { ok?: boolean } | undefined;
    return result?.ok !== false;
  }

  /**
   * Send a tool result for an interactive tool.
   */
  async sendToolResult(
    sessionId: string,
    toolUseId: string,
    content: string,
    isError = false,
  ): Promise<boolean> {
    const result = (await this.sendRequest({
      type: "session.send_tool_result",
      requestId: "",
      sessionId,
      toolUseId,
      content,
      isError,
    })) as { ok?: boolean } | undefined;
    return result?.ok !== false;
  }

  /**
   * Close all sessions (for extension shutdown).
   */
  async closeAll(): Promise<void> {
    const sessions = await this.list();
    for (const session of sessions) {
      const id = (session as { id: string }).id;
      if (id) {
        await this.close(id).catch(() => {});
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────

  /**
   * Send a request and await the response.
   */
  private sendRequest(msg: ClientMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this._isConnected) {
        reject(new Error("Not connected to agent-host"));
        return;
      }

      const requestId = randomUUID();
      // Override the placeholder requestId
      const fullMsg = { ...msg, requestId };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timed out: ${msg.type}`));
      }, AgentHostClient.REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify(fullMsg));
    });
  }

  /**
   * Handle an incoming WebSocket message.
   */
  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn("Invalid JSON from agent-host", { raw: raw.slice(0, 100) });
      return;
    }

    if (msg.type === "res") {
      this.handleResponse(msg as unknown as ResponseMessage);
    } else if (msg.type === "session.event") {
      this.handleSessionEvent(msg as unknown as SessionEventMessage);
    } else if (msg.type === "task.event") {
      this.handleTaskEvent(msg as unknown as TaskEventMessage);
    }
  }

  /**
   * Handle a response to a pending request.
   */
  private handleResponse(msg: ResponseMessage): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.requestId);

    if (msg.ok) {
      pending.resolve(msg.payload);
    } else {
      pending.reject(new Error(msg.error || "Request failed"));
    }
  }

  /**
   * Handle a streaming session event.
   * Updates lastSeenSeq and emits "session.event" in the same format
   * as SessionManager, so the session extension's event wiring works unchanged.
   */
  private handleSessionEvent(msg: SessionEventMessage): void {
    // Track sequence for reconnection replay
    this.lastSeenSeq.set(msg.sessionId, msg.seq);

    // Emit in the same format as SessionManager.wireSession
    this.emit("session.event", {
      eventName: `session.${msg.sessionId}.${msg.event.type}`,
      sessionId: msg.sessionId,
      ...msg.event,
    });
  }

  private handleTaskEvent(msg: TaskEventMessage): void {
    this.lastSeenTaskSeq.set(msg.taskId, msg.seq);
    this.emit("task.event", {
      taskId: msg.taskId,
      eventName: `task.${msg.taskId}.${msg.event.type}`,
      ...msg.event,
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      log.info("Attempting reconnection", { backoff: this.reconnectBackoff });

      try {
        await this.connect();
        log.info("Reconnected to agent-host");
      } catch {
        this.reconnectBackoff = Math.min(
          this.reconnectBackoff * 2,
          AgentHostClient.MAX_RECONNECT_BACKOFF,
        );
        this.scheduleReconnect();
      }
    }, this.reconnectBackoff);
  }
}
