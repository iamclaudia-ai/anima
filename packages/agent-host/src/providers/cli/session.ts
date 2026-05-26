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
import {
  capturePane,
  claudeProcessAlive,
  hasSession,
  killSession,
  newSession,
  pasteText,
  runInPane,
  sendKey,
  submit,
} from "./tmux";
import { copyImageToClipboard } from "./image-clipboard";
import { ensureMitmCerts } from "./mitm-certs";

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
/** Settle time after each Ctrl-V so the TUI reads the clipboard + renders `[Image #N]`. */
const IMAGE_INGEST_MS = 700;
/** Settle delay after a paste before we check the pane echo. */
const PASTE_SETTLE_MS = 200;
/** How long to wait for the pasted text to appear in `capture-pane`. */
const ECHO_TIMEOUT_MS = 500;
/** Probe slice we look for in the pane to confirm the paste landed. */
const ECHO_PROBE_LEN = 40;

/** First non-empty trimmed line of the paste, capped — distinctive enough to grep. */
function echoProbe(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return firstLine.trim().slice(0, ECHO_PROBE_LEN);
}

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

interface ParsedPrompt {
  text: string;
  images: Array<{ data: string; mediaType: string }>;
}

/** Split inbound content into submit text and base64 image attachments. */
function parsePromptContent(content: string | unknown[]): ParsedPrompt {
  if (typeof content === "string") return { text: content, images: [] };
  const images: ParsedPrompt["images"] = [];
  const textParts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const r = b as Record<string, unknown>;
    if (r.type === "text") {
      textParts.push(String(r.text ?? ""));
    } else if (r.type === "image") {
      const src = (r.source ?? {}) as Record<string, unknown>;
      const data = src.data;
      if (typeof data === "string" && data) {
        const mediaType = typeof src.media_type === "string" ? src.media_type : "image/png";
        images.push({ data, mediaType });
      }
    }
  }
  return { text: textParts.filter(Boolean).join("\n"), images };
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
  /** Transport: "base-url" (ANTHROPIC_BASE_URL) or "mitm" (HTTPS_PROXY + CA). */
  private readonly interception: "base-url" | "mitm";
  /** CA path for NODE_EXTRA_CA_CERTS — set when interception is "mitm". */
  private caPath = "";

  private _isStarted = false;
  private _isClosed = false;
  private _turnActive = false;
  /** True once claude has been launched at least once — recovery uses --resume. */
  private _launched = false;

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
    this.interception = config.interception === "mitm" ? "mitm" : "base-url";
  }

  async start(): Promise<void> {
    if (this._isStarted) throw new Error("Session already started");
    const reused = await this.ensureRunning();
    this._isStarted = true;
    this._isClosed = false;
    this.lastActivityTime = Date.now();
    this.emit("ready", { sessionId: this.id });
    this.emit("process_started");
    log.info("Started", { id: this.id.slice(0, 8), port: this.proxyPort, reuse: reused });
  }

  /** Lazily (re)start the tee proxy on this session's deterministic port. */
  private async ensureProxy(): Promise<void> {
    if (this.proxy) return;
    let tls: { key: string; cert: string } | undefined;
    if (this.interception === "mitm") {
      const certs = ensureMitmCerts();
      tls = { key: certs.key, cert: certs.cert };
      this.caPath = certs.caPath;
    }
    this.proxy = new AnthropicTeeProxy({
      port: derivePort(this.config.basePort ?? DEFAULT_BASE_PORT, this.id),
      onEvent: (e, ctx) => this.handleProxyEvent(e, ctx),
      onRequestBody: (b, ctx) => this.handleRequestBody(b, ctx),
      capture: this.config.capture,
      context1m: this.wants1m,
      interception: this.interception,
      tls,
    });
    this.proxyPort = await this.proxy.start();
  }

  /**
   * Make the runtime live: proxy up, tmux pane up, and the `claude` process
   * actually running. Recovers whatever is missing and returns true only when a
   * fully-healthy session was reused untouched.
   *
   * - pane + claude alive → reuse as-is.
   * - pane alive, claude dead → relaunch in-pane (keeps any attached client).
   * - no pane → spawn a fresh detached session.
   *
   * Throws if claude still isn't running after a (re)launch so the caller can
   * surface the failure instead of silently pasting into a dead pane.
   */
  private async ensureRunning(): Promise<boolean> {
    await this.ensureProxy();

    if (hasSession(this.tmuxName) && claudeProcessAlive(this.id)) return true;

    if (hasSession(this.tmuxName)) {
      // Pane survived but claude exited (crash, or a manually re-created shell).
      this.launchInPane();
    } else {
      killSession(this.tmuxName); // clear any half-dead record
      this.spawn();
    }
    await this.waitForReady();

    if (!claudeProcessAlive(this.id)) {
      throw new Error(`Claude CLI failed to start in tmux session ${this.tmuxName}`);
    }
    this._isClosed = false;
    return false;
  }

  /** Build the claude argv + env. `resume` picks --resume vs --session-id. */
  private claudeCommand(resume: boolean): { command: string[]; env: Record<string, string> } {
    const claudeBin = findClaude(this.config.cliPath);
    const args = resume ? ["--resume", this.id] : ["--session-id", this.id];
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
    // Force the subscription OAuth path: clear any API-key vars. Then route the
    // CLI at our proxy per transport — base-url points ANTHROPIC_BASE_URL at the
    // origin; mitm sets HTTPS_PROXY + a trusted CA and leaves the base URL unset
    // (so it talks to the real api.anthropic.com, which we transparently MITM).
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    };
    if (this.interception === "mitm") {
      const proxyUrl = `http://127.0.0.1:${this.proxyPort}`;
      env.HTTPS_PROXY = proxyUrl;
      env.HTTP_PROXY = proxyUrl;
      env.NODE_EXTRA_CA_CERTS = this.caPath;
      env.ANTHROPIC_BASE_URL = ""; // clear any inherited base url
    } else {
      env.ANTHROPIC_BASE_URL = `http://localhost:${this.proxyPort}`;
    }
    return { command: [claudeBin, ...args], env };
  }

  private spawn(): void {
    // First launch of a freshly-created session creates it (--session-id); every
    // later (re)launch resumes the now-existing session.
    const { command, env } = this.claudeCommand(this.isResume || this._launched);
    newSession({ name: this.tmuxName, cwd: this.cwd, command, env });
    this._launched = true;
  }

  private launchInPane(): void {
    const { command, env } = this.claudeCommand(true);
    runInPane(this.tmuxName, command, env);
    this._launched = true;
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
    const { text, images } = parsePromptContent(content);
    log.info("prompt received", {
      ...this.stateSnapshot(),
      chars: text.length,
      images: images.length,
      contentType:
        typeof content === "string" ? "string" : Array.isArray(content) ? "array" : typeof content,
    });
    if (!text.trim() && images.length === 0) {
      log.warn("prompt resolved to empty content — nothing sent to TUI", {
        id: this.id.slice(0, 8),
      });
      return;
    }

    // Escape hatch: `/restart` tears the runtime down and relaunches with
    // --resume, recovering from a wedged TUI (e.g. stuck in /compact confirm,
    // input swallowed by a modal). Doesn't get pasted to the CLI.
    if (images.length === 0 && text.trim() === "/restart") {
      await this.handleRestartCommand();
      return;
    }

    // Durability: verify (and recover) proxy + tmux + claude before every send,
    // so an idle-reaped, crashed, or hand-recreated session heals automatically
    // instead of pasting into a dead or shell-only pane.
    const reused = await this.ensureRunning();
    this._isStarted = true;
    if (!reused) {
      log.info("prompt recovered dead runtime before send", this.stateSnapshot());
    }
    this.lastActivityTime = Date.now();
    this._turnActive = true;

    // Attach images first: load each onto the macOS clipboard and Ctrl-V it into
    // the input (claude reads the pasteboard on Ctrl-V), giving the TUI time to
    // ingest and render the `[Image #N]` placeholder before the next paste.
    let pasted = 0;
    for (const img of images) {
      if (copyImageToClipboard(img.data, img.mediaType)) {
        sendKey(this.tmuxName, "C-v");
        await new Promise((r) => setTimeout(r, IMAGE_INGEST_MS));
        pasted++;
      } else {
        log.warn("image clipboard paste failed — skipping attachment", {
          id: this.id.slice(0, 8),
          mediaType: img.mediaType,
        });
      }
    }

    // Then the text (no submit), echo-gate it, then submit the whole turn once.
    if (text.trim()) {
      const landed = await this.pasteWithEchoGate(text);
      if (!landed) {
        // Echo gate logged + emitted submit_failed; release the UI spinner.
        this.emit("sse", {
          type: "turn_stop",
          timestamp: new Date().toISOString(),
          stop_reason: "submit_failed",
        } satisfies StreamEvent);
        this.endTurn();
        return;
      }
    }
    submit(this.tmuxName);
    log.info("prompt submitted to tmux", {
      ...this.stateSnapshot(),
      images: pasted,
    });
  }

  /** Snapshot of runtime state — included in every prompt-path log entry. */
  private stateSnapshot(): Record<string, unknown> {
    return {
      id: this.id.slice(0, 8),
      tmux: this.tmuxName,
      tmuxAlive: hasSession(this.tmuxName),
      claudeAlive: claudeProcessAlive(this.id),
      started: this._isStarted,
      closed: this._isClosed,
      turnActive: this._turnActive,
      launched: this._launched,
      proxyPort: this.proxyPort,
      lastActivityMs: Date.now() - this.lastActivityTime,
    };
  }

  /** Last `lines` lines of the pane — handy for "what was on screen when X failed". */
  private paneTail(lines: number): string {
    return capturePane(this.tmuxName).split("\n").slice(-lines).join("\n");
  }

  /**
   * Paste `text` and confirm it appeared in the pane. If the first paste is
   * silently swallowed (TUI in a /compact confirm modal, stale focus, etc.),
   * dismiss with Escape and retry once. On final failure, emit a `submit_failed`
   * SSE so the UI can show a recoverable error instead of looking hung.
   *
   * Returns true when the probe was found and the caller should `submit`.
   */
  private async pasteWithEchoGate(text: string): Promise<boolean> {
    const probe = echoProbe(text);
    pasteText(this.tmuxName, text);
    await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
    if (await this.waitForEcho(probe, ECHO_TIMEOUT_MS)) return true;

    log.warn("paste echo missing — dismissing modals and retrying once", {
      ...this.stateSnapshot(),
      probe,
      paneTail: this.paneTail(6),
    });
    // Escape clears modal prompts (/compact confirm, permission dialogs).
    // Cost: if a turn was somehow already in flight, it gets interrupted —
    // acceptable, because the only reason we're here is the user just submitted.
    sendKey(this.tmuxName, "Escape");
    await new Promise((r) => setTimeout(r, 250));
    pasteText(this.tmuxName, text);
    await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
    if (await this.waitForEcho(probe, ECHO_TIMEOUT_MS)) {
      log.info("paste echo recovered after Escape+retry", { id: this.id.slice(0, 8), probe });
      return true;
    }

    log.error("paste echo still missing after retry — aborting submit", {
      ...this.stateSnapshot(),
      probe,
      paneTail: this.paneTail(10),
    });
    this.emit("sse", {
      type: "submit_failed",
      timestamp: new Date().toISOString(),
      reason: "echo_missing",
      hint: "The Claude TUI didn't echo the prompt — it may be wedged in a modal. Send `/restart` to relaunch.",
    } satisfies StreamEvent);
    return false;
  }

  /** Poll capture-pane for the probe substring up to `timeoutMs`. */
  private async waitForEcho(probe: string, timeoutMs: number): Promise<boolean> {
    if (!probe) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (capturePane(this.tmuxName).includes(probe)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /** Force-relaunch the CLI in a fresh tmux pane — recovery from a wedged TUI. */
  private async handleRestartCommand(): Promise<void> {
    log.info("/restart received — tearing down and relaunching", this.stateSnapshot());
    killSession(this.tmuxName);
    // Don't tear down the proxy — it survives across CLI restarts on the same
    // deterministic port, and the new claude process inherits the same env.
    this._launched = true; // force --resume on relaunch, not --session-id
    this._isClosed = false;
    await this.ensureRunning();
    this._isStarted = true;
    this.lastActivityTime = Date.now();
    log.info("/restart complete", this.stateSnapshot());
    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: "restarted",
    } satisfies StreamEvent);
    this.endTurn();
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
    return this.proxy !== null && hasSession(this.tmuxName) && claudeProcessAlive(this.id);
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
