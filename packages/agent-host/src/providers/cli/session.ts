/**
 * Claude CLI runtime session (#33).
 *
 * Drives the real `claude` TUI in a tmux pane (subscription-compliant auth,
 * tool execution, history, permissions all handled by the CLI) and observes the
 * model stream via a local tee proxy. Implements the same `AgentRuntimeSession`
 * shape as the SDK and Codex providers, so session-host / clients are unchanged.
 *
 * Key behaviors:
 * - Native Anthropic SSE is emitted as `"sse"` events (near-identity mapping).
 * - Haiku pre-flight (title-gen) streams are swallowed so they don't pollute the
 *   chat. (PR 2: route to `session.title_generated`.)
 * - A turn ends only on a non-Haiku `message_stop` with a terminal stop_reason —
 *   `tool_use` continuations stay part of the same logical turn.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@anima/shared";
import type {
  AgentRuntimeSessionInfo,
  CreateSessionOptions,
  ResumeSessionOptions,
  StreamEvent,
} from "../../provider-types";
import { AnthropicTeeProxy, type StreamContext } from "./proxy";
import { capturePane, hasSession, killSession, newSession, sendKey, sendText } from "./tmux";

const log = createLogger("ClaudeCliSession", join(homedir(), ".anima", "logs", "agent-host.log"));

export interface ClaudeCliProviderConfig {
  /** Absolute path to the claude binary (auto-detected if omitted). */
  cliPath?: string;
  /** Base port for the per-session tee proxy (default 9000). */
  basePort?: number;
  /** Interception mode — PR 1 supports "base-url" only. */
  interception?: "base-url" | "mitm";
  /** Fallback model when the session options omit one. */
  model?: string;
  /** Append full request/response JSON to the proxy capture file (debugging). */
  capture?: boolean;
}

const DEFAULT_BASE_PORT = 9000;
const DISALLOWED_TOOLS = "AskUserQuestion,EnterPlanMode,ExitPlanMode";
const TERMINAL_STOP = new Set(["end_turn", "stop_sequence", "max_tokens"]);
const INIT_TIMEOUT_MS = 12_000;
const STALE_MS = 5 * 60 * 1000;

function findClaude(configPath?: string): string {
  if (configPath && existsSync(configPath)) return configPath;
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return Bun.which("claude") ?? "claude";
}

function promptToText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const r = b as Record<string, unknown>;
      if (r.type === "text") return String(r.text ?? "");
      if (r.type === "image") return "[image attachment]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Strip an Anima model-variant suffix like "[1m]" before passing `--model` to
 * the CLI. Anthropic rejects "claude-opus-4-7[1m]" as a model name (404
 * not_found); the 1M context window rides on the `context-1m-2025-08-07` beta
 * header the CLI sends automatically, so the bare model id is what we want.
 */
function sanitizeModel(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, "").trim();
}

/** Deterministic port from session id so resume reuses the same proxy. */
function derivePort(base: number, id: string): number {
  let h = 0;
  for (const ch of id) h += ch.charCodeAt(0);
  return base + (h % 1000);
}

export class ClaudeCliSession extends EventEmitter {
  readonly id: string;

  private proxy: AnthropicTeeProxy | null = null;
  private readonly tmuxName: string;
  private proxyPort = 0;

  private readonly cwd: string;
  /** Bare model id (suffix stripped) — used only for getInfo() reporting. */
  private readonly model: string;
  /**
   * Model id passed to the CLI's `--model`. Keeps the `[1m]` variant so the TUI's
   * context meter and auto-compaction threshold use the 1M window; the proxy
   * rewrites it to the bare id on the wire so the API never sees `[1m]`.
   */
  private readonly cliModel: string;
  /** True when the configured model carried the `[1m]` 1M-context variant. */
  private readonly wants1m: boolean;
  private readonly systemPrompt?: string;
  private readonly isResume: boolean;

  private _isStarted = false;
  private _isClosed = false;
  private _turnActive = false;

  // Turn tracking — the latest non-terminal/terminal stop reason on the agent stream.
  private lastStopReason = "";

  private readonly createdAt = Date.now();
  private lastActivityTime = Date.now();

  constructor(
    id: string,
    options: CreateSessionOptions | ResumeSessionOptions,
    isResume: boolean,
    private readonly config: ClaudeCliProviderConfig = {},
  ) {
    super();
    this.id = id;
    this.tmuxName = `anima-cli-${id}`;
    this.cwd = options.cwd;
    const rawModel = options.model || config.model || "claude-opus-4-6";
    this.wants1m = /\[1m\]/i.test(rawModel);
    this.model = sanitizeModel(rawModel);
    this.cliModel = rawModel;
    this.systemPrompt = "systemPrompt" in options ? options.systemPrompt : undefined;
    this.isResume = isResume;
  }

  async start(): Promise<void> {
    if (this._isStarted) throw new Error("Session already started");

    this.proxy = new AnthropicTeeProxy({
      port: derivePort(this.config.basePort ?? DEFAULT_BASE_PORT, this.id),
      onEvent: (e, ctx) => this.handleProxyEvent(e, ctx),
      onRequestBody: (b, ctx) => this.handleRequestBody(b, ctx),
      capture: this.config.capture,
      context1m: this.wants1m,
    });
    this.proxyPort = this.proxy.start();

    const reuse = this.isResume && hasSession(this.tmuxName);
    if (!reuse) {
      killSession(this.tmuxName);
      this.spawn();
      await this.waitForReady();
    }

    this._isStarted = true;
    this._isClosed = false;
    this.lastActivityTime = Date.now();
    this.emit("ready", { sessionId: this.id });
    this.emit("process_started");
    log.info("Started", { id: this.id.slice(0, 8), port: this.proxyPort, reuse });
  }

  private spawn(): void {
    const claudeBin = findClaude(this.config.cliPath);
    const args = this.isResume ? ["--resume", this.id] : ["--session-id", this.id];
    args.push(
      "--model",
      this.cliModel,
      "--dangerously-skip-permissions",
      "--disallowedTools",
      DISALLOWED_TOOLS,
    );
    if (this.systemPrompt && this.systemPrompt.trim()) {
      args.push("--append-system-prompt", this.systemPrompt.trim());
    }
    newSession({
      name: this.tmuxName,
      cwd: this.cwd,
      command: [claudeBin, ...args],
      // Force the subscription OAuth path: clear any API-key vars and point the
      // CLI at our proxy.
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: `http://localhost:${this.proxyPort}`,
      },
    });
  }

  /** Poll the pane until the TUI input box renders (or content stabilizes). */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + INIT_TIMEOUT_MS;
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const pane = capturePane(this.tmuxName);
      if (/shortcuts|│\s*>|Welcome to Claude/i.test(pane)) return;
      if (pane && pane === last) {
        if (++stable >= 3) return;
      } else {
        stable = 0;
        last = pane;
      }
    }
    log.warn("waitForReady timed out", { id: this.id.slice(0, 8) });
  }

  async prompt(content: string | unknown[]): Promise<void> {
    if (!this._isStarted) throw new Error("Session not started");
    const text = promptToText(content);
    log.info("prompt received", {
      id: this.id.slice(0, 8),
      chars: text.length,
      contentType:
        typeof content === "string" ? "string" : Array.isArray(content) ? "array" : typeof content,
    });
    if (!text.trim()) {
      log.warn("prompt resolved to empty text — nothing sent to TUI", { id: this.id.slice(0, 8) });
      return;
    }
    this.lastActivityTime = Date.now();
    this._turnActive = true;
    await sendText(this.tmuxName, text);
    log.info("prompt pasted to tmux", { id: this.id.slice(0, 8), tmux: this.tmuxName });
  }

  interrupt(): void {
    if (!this._isStarted) return;
    sendKey(this.tmuxName, "Escape");
    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: "abort",
    } satisfies StreamEvent);
    this.endTurn();
    this.emit("interrupted");
  }

  async close(): Promise<void> {
    if (!this._isStarted && !this.proxy) return;
    this._isClosed = true;
    killSession(this.tmuxName);
    this.proxy?.stop();
    this.proxy = null;
    this._isStarted = false;
    this.emit("closed");
    log.info("Closed", { id: this.id.slice(0, 8) });
  }

  setPermissionMode(_mode: string): void {
    // No-op: the CLI runs with --dangerously-skip-permissions.
  }

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {
    // No-op: the CLI executes its own tools.
  }

  get isActive(): boolean {
    return this._isStarted && !this._isClosed;
  }

  get isProcessRunning(): boolean {
    return this.proxy !== null && hasSession(this.tmuxName);
  }

  getInfo(): AgentRuntimeSessionInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivity: new Date(this.lastActivityTime).toISOString(),
      healthy: this.isActive,
      stale: Date.now() - this.lastActivityTime >= STALE_MS,
    };
  }

  private endTurn(): void {
    if (this._turnActive) {
      this._turnActive = false;
      this.emit("process_ended");
    }
  }

  private handleProxyEvent(event: StreamEvent, ctx: StreamContext): void {
    // Drop auxiliary streams (title-gen, quota probe, topic detection) so they
    // never reach the chat — only real agent turns carry the toolset.
    if (!ctx.isAgentTurn) return;

    this.lastActivityTime = Date.now();
    const type = event.type;

    if (type === "message_delta") {
      const sr = (event as { delta?: { stop_reason?: string } }).delta?.stop_reason;
      if (sr) this.lastStopReason = sr;
    }

    this.emit("sse", event);

    if (type === "message_stop" && TERMINAL_STOP.has(this.lastStopReason)) {
      this.emit("sse", {
        type: "turn_stop",
        timestamp: new Date().toISOString(),
        stop_reason: this.lastStopReason,
      } satisfies StreamEvent);
      this.endTurn();
    }
  }

  /** Surface tool_result blocks the CLI sends in its continuation request. */
  private handleRequestBody(body: unknown, ctx: StreamContext): void {
    if (!ctx.isAgentTurn) return;
    if (!body || typeof body !== "object") return;
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const last = messages[messages.length - 1] as { role?: string; content?: unknown };
    if (last?.role !== "user" || !Array.isArray(last.content)) return;
    const toolResults = (last.content as Array<Record<string, unknown>>).filter(
      (c) => c.type === "tool_result",
    );
    if (toolResults.length === 0) return;
    this.emit("sse", {
      type: "request_tool_results",
      timestamp: new Date().toISOString(),
      tool_results: toolResults.map((c) => ({
        tool_use_id: c.tool_use_id,
        content: c.content,
        is_error: c.is_error,
      })),
    } satisfies StreamEvent);
  }
}

export function createClaudeCliProvider(config: ClaudeCliProviderConfig = {}) {
  return {
    create: (options: CreateSessionOptions): ClaudeCliSession =>
      new ClaudeCliSession(options.sessionId || randomUUID(), options, false, config),
    resume: (sessionId: string, options: ResumeSessionOptions): ClaudeCliSession =>
      new ClaudeCliSession(sessionId, options, true, config),
  };
}
