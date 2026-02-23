/**
 * Session Host — manages SDKSession instances inside the agent-host server.
 *
 * This is the agent-host equivalent of SessionManager from the session extension.
 * Key differences:
 * - Lives in the agent-host process (separate from gateway/extensions)
 * - Broadcasts events to WebSocket clients instead of ctx.emit()
 * - Uses EventBuffer for reconnection replay
 * - Persists session registry to disk for crash recovery
 *
 * SDKSession and its dependencies (MessageChannel, query()) are imported
 * directly from the session extension's sdk-session module.
 */

import { EventEmitter } from "node:events";
import {
  SDKSession,
  createSDKSession,
  resumeSDKSession,
  type CreateSessionOptions,
  type ResumeSessionOptions,
  type StreamEvent,
} from "../../../extensions/session/src/sdk-session";
import { EventBuffer, type BufferedEvent } from "./event-buffer";
import type { SessionEventMessage } from "./protocol";
import { createLogger } from "@claudia/shared";
import type { ThinkingEffort } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("SessionHost", join(homedir(), ".claudia", "logs", "agent-host.log"));

// ── Types ────────────────────────────────────────────────────

export interface SessionCreateParams {
  /** Working directory */
  cwd: string;
  /** Model to use */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Enable adaptive thinking */
  thinking?: boolean;
  /** Thinking effort level */
  effort?: ThinkingEffort;
}

export interface SessionResumeParams {
  /** Claude Code session UUID to resume */
  sessionId: string;
  /** Working directory */
  cwd: string;
  /** Model to use */
  model?: string;
  /** Enable adaptive thinking */
  thinking?: boolean;
  /** Thinking effort level */
  effort?: ThinkingEffort;
}

/** Session defaults from config */
export interface SessionDefaults {
  model?: string;
  thinking?: boolean;
  effort?: ThinkingEffort;
}

/** Serializable session metadata for persistence */
export interface SessionRecord {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  lastActivity: string;
}

// ── SessionHost ──────────────────────────────────────────────

/**
 * Manages all SDK sessions and their event buffers.
 *
 * Emits "session.event" with SessionEventMessage payloads for WebSocket broadcast.
 * Each session gets its own EventBuffer for reconnection replay.
 */
export class SessionHost extends EventEmitter {
  private sessions = new Map<string, SDKSession>();
  private eventBuffers = new Map<string, EventBuffer>();
  private defaults: SessionDefaults = {};
  private deps: {
    create: typeof createSDKSession;
    resume: typeof resumeSDKSession;
  };

  constructor(deps?: { create?: typeof createSDKSession; resume?: typeof resumeSDKSession }) {
    super();
    this.deps = {
      create: deps?.create || createSDKSession,
      resume: deps?.resume || resumeSDKSession,
    };
  }

  /**
   * Set session defaults for lazy-resume fallback.
   */
  setDefaults(defaults: SessionDefaults): void {
    this.defaults = defaults;
  }

  /**
   * Create a new Claude session.
   */
  async create(params: SessionCreateParams): Promise<{ sessionId: string }> {
    const options: CreateSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      systemPrompt: params.systemPrompt,
      thinking: params.thinking,
      effort: params.effort,
    };

    const session = this.deps.create(options);
    await session.start();

    this.sessions.set(session.id, session);
    this.eventBuffers.set(session.id, new EventBuffer());
    this.wireSession(session);

    log.info("Created session", { sessionId: session.id.slice(0, 8) });
    return { sessionId: session.id };
  }

  /**
   * Resume an existing Claude session.
   */
  async resume(params: SessionResumeParams): Promise<{ sessionId: string }> {
    // Check if already active
    const existing = this.sessions.get(params.sessionId);
    if (existing?.isActive) {
      log.info("Session already active", { sessionId: params.sessionId.slice(0, 8) });
      return { sessionId: existing.id };
    }

    const options: ResumeSessionOptions = {
      cwd: params.cwd,
      model: params.model,
      thinking: params.thinking,
      effort: params.effort,
    };

    const session = this.deps.resume(params.sessionId, options);
    await session.start();

    this.sessions.set(session.id, session);
    if (!this.eventBuffers.has(session.id)) {
      this.eventBuffers.set(session.id, new EventBuffer());
    }
    this.wireSession(session);

    log.info("Resumed session", { sessionId: session.id.slice(0, 8) });
    return { sessionId: session.id };
  }

  /**
   * Send a prompt to a session.
   * If the session isn't running, auto-resumes it first (lazy start).
   */
  async prompt(sessionId: string, content: string | unknown[], cwd?: string): Promise<void> {
    let session = this.sessions.get(sessionId);

    if (!session || !session.isActive) {
      // Lazy resume — session died or agent-host restarted
      if (!cwd) {
        throw new Error(`Session not found and no cwd provided for auto-resume: ${sessionId}`);
      }
      log.info("Auto-resuming session", {
        sessionId: sessionId.slice(0, 8),
        cwd,
        model: this.defaults.model || "default",
      });
      await this.resume({
        sessionId,
        cwd,
        model: this.defaults.model,
        thinking: this.defaults.thinking,
        effort: this.defaults.effort,
      });
      session = this.sessions.get(sessionId)!;
    }

    session.prompt(content);
  }

  /**
   * Interrupt a session's current response.
   */
  interrupt(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.interrupt();
    return true;
  }

  /**
   * Set the permission mode for a session.
   */
  setPermissionMode(sessionId: string, mode: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.setPermissionMode(mode);
    return true;
  }

  /**
   * Send a tool_result for an interactive tool.
   */
  sendToolResult(sessionId: string, toolUseId: string, content: string, isError = false): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.sendToolResult(toolUseId, content, isError);
    return true;
  }

  /**
   * Close a session — kill process.
   */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await session.close();
    this.sessions.delete(sessionId);
    // Keep event buffer around briefly for clients that haven't seen close yet
    log.info("Closed session", { sessionId: sessionId.slice(0, 8) });
  }

  /**
   * List all active sessions.
   */
  list(): Array<ReturnType<SDKSession["getInfo"]>> {
    return Array.from(this.sessions.values()).map((s) => s.getInfo());
  }

  /**
   * Get buffered events after a given sequence number (for reconnection replay).
   */
  getEventsAfter(sessionId: string, lastSeq: number): BufferedEvent[] {
    const buffer = this.eventBuffers.get(sessionId);
    if (!buffer) return [];
    return buffer.getAfter(lastSeq);
  }

  /**
   * Get active session IDs (for persistence).
   */
  getSessionRecords(): SessionRecord[] {
    return Array.from(this.sessions.values()).map((s) => {
      const info = s.getInfo();
      return {
        id: info.id,
        cwd: info.cwd,
        model: info.model,
        createdAt: info.createdAt,
        lastActivity: info.lastActivity,
      };
    });
  }

  /**
   * Close all sessions — for graceful shutdown.
   */
  async closeAll(): Promise<void> {
    const promises = Array.from(this.sessions.keys()).map((id) => this.close(id));
    await Promise.all(promises);
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Wire a session's events to the event buffer and emit for WebSocket broadcast.
   *
   * Each SSE event from the SDK gets:
   * 1. Buffered with a monotonic sequence number
   * 2. Emitted as "session.event" for the WebSocket server to broadcast
   */
  private wireSession(session: SDKSession): void {
    const sessionId = session.id;

    session.on("sse", (event: StreamEvent) => {
      const buffer = this.eventBuffers.get(sessionId);
      if (!buffer) return;

      const seq = buffer.push(event);

      const msg: SessionEventMessage = {
        type: "session.event",
        sessionId,
        event: event as { type: string; [key: string]: unknown },
        seq,
      };

      this.emit("session.event", msg);
    });

    session.on("process_started", () => {
      const buffer = this.eventBuffers.get(sessionId);
      if (!buffer) return;

      const event = { type: "process_started" };
      const seq = buffer.push(event);

      this.emit("session.event", {
        type: "session.event",
        sessionId,
        event,
        seq,
      } satisfies SessionEventMessage);
    });

    session.on("process_ended", () => {
      const buffer = this.eventBuffers.get(sessionId);
      if (!buffer) return;

      const event = { type: "process_ended" };
      const seq = buffer.push(event);

      this.emit("session.event", {
        type: "session.event",
        sessionId,
        event,
        seq,
      } satisfies SessionEventMessage);
    });

    session.on("closed", () => {
      this.sessions.delete(sessionId);
      this.eventBuffers.delete(sessionId);
      log.info("Cleaned up session buffers", { sessionId: sessionId.slice(0, 8) });
    });
  }
}
