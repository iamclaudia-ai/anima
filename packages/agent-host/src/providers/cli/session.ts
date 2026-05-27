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
/** Settle delay after a paste before we send Enter to submit. */
const PASTE_SETTLE_MS = 200;
/** Max wait after submit for Claude to start a new turn (proves paste landed). */
const TURN_START_TIMEOUT_MS = 15_000;
/** Max wait for an in-flight turn to clear before we paste a new prompt. */
const PROMPT_READY_TIMEOUT_MS = 60_000;
/** Sample interval for cold-start pane-idle detection. */
const PANE_IDLE_SAMPLE_MS = 250;
/** Consecutive unchanged captures that count as "TUI idle". */
const PANE_IDLE_STABLE_SAMPLES = 3;
/** Cap on the cold-start idle wait. */
const PANE_IDLE_TIMEOUT_MS = 10_000;

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
  /**
   * True once we've observed at least one proxy SSE event since (re)start.
   * Until then, `_turnActive` is just a default — the *actual* TUI could be
   * mid-turn from before we attached. Cold start uses pane-idle detection to
   * bootstrap before trusting `_turnActive`.
   */
  private _turnStateKnown = false;
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
    // Fresh instance — no SSE history, so we can't trust `_turnActive` until
    // either a proxy event arrives or pane-idle detection bootstraps us.
    this._turnStateKnown = false;
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
    // We just (re)launched claude; the prior `_turnActive` is stale.
    this._turnStateKnown = false;
    this._turnActive = false;
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

  /**
   * Does this pane capture show a rendered Claude TUI? Looks for stable
   * markers that appear in *any* rendered state — fresh launch, resumed
   * session, mid-turn — so a resumed pane (where the welcome banner has
   * scrolled off) doesn't get treated as empty.
   *
   * - `bypass permissions on` — bottom-bar status text, present once the
   *   TUI has fully drawn its chrome (every YOLO-mode session, fresh or
   *   resumed). The reliable marker.
   * - `⏵⏵` — the bypass-permissions indicator on the same row.
   * - `│\s*>` — the input box for fresh sessions where the bottom bar
   *   may be scrolled off in `capture-pane` output.
   * - `Welcome to Claude` / `Welcome back` — startup banner (fresh launch).
   *
   * An empty / whitespace-only pane returns false even if "stable" — the
   * TUI hasn't painted yet, so pasting into it would land in a void.
   */
  private static tuiRendered(pane: string): boolean {
    return /bypass permissions on|⏵⏵|│\s*>|Welcome (to Claude|back)/i.test(pane);
  }

  /** Poll the pane until the TUI input box renders. */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + INIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (ClaudeCliSession.tuiRendered(capturePane(this.tmuxName))) return;
    }
    log.warn("waitForReady timed out — no TUI markers in pane", {
      id: this.id.slice(0, 8),
      paneTail: this.paneTail(6),
    });
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

    // Positive ready signal before pasting: wait for any in-flight turn to
    // clear (via `_turnActive` from proxy SSE), bootstrapping with pane-idle
    // detection on cold start when we haven't seen any SSE yet. Never sends
    // destructive keys to "unstick" the TUI — surface submit_failed instead.
    const ready = await this.waitForPromptReady(PROMPT_READY_TIMEOUT_MS);
    if (!ready.ok) {
      log.warn("TUI not ready for prompt — aborting submit", {
        ...this.stateSnapshot(),
        reason: ready.reason,
      });
      this.emit("sse", {
        type: "submit_failed",
        timestamp: new Date().toISOString(),
        reason: ready.reason,
        paneTail: this.paneTail(10),
        hint:
          ready.reason === "turn_active"
            ? "Claude is still working on the previous turn. Wait for it to finish, or interrupt and resend."
            : "Couldn't confirm the Claude TUI is idle. Send `/restart` if it stays stuck.",
      } satisfies StreamEvent);
      this.emit("sse", {
        type: "turn_stop",
        timestamp: new Date().toISOString(),
        stop_reason: "submit_failed",
      } satisfies StreamEvent);
      return;
    }
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

    // Paste text + submit, then verify Claude actually started a new agent
    // turn via SSE. The SSE `message_start` is the source-of-truth signal that
    // the paste landed and was processed — pane-scraping for `[Pasted text #N]`
    // is unreliable across paste sizes (31KB conversation transcripts render
    // and consume the placeholder faster than we can poll) and TUI states.
    // No retry-with-Esc: if Claude doesn't start a turn, we surface
    // submit_failed cleanly and the caller decides next steps.
    if (text.trim()) {
      const landed = await this.pasteSubmitAndConfirmTurnStart(text);
      if (!landed) {
        this.emit("sse", {
          type: "turn_stop",
          timestamp: new Date().toISOString(),
          stop_reason: "submit_failed",
        } satisfies StreamEvent);
        this.endTurn();
        return;
      }
      log.info("prompt submitted to tmux", {
        ...this.stateSnapshot(),
        images: pasted,
      });
      return;
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
   * Wait until the TUI is ready to accept a paste. Returns a positive-signal
   * verdict — never sends keystrokes to "unstick" the TUI.
   *
   * - Hot path (we've observed at least one SSE event from the proxy since
   *   start/relaunch): just wait for `_turnActive` to clear. Trustworthy
   *   because the proxy is the source of truth for turn state.
   * - Cold path (no SSE yet — first prompt after start/resume): bootstrap by
   *   sampling `capture-pane` until content stabilizes, then re-check
   *   `_turnActive` (which an in-flight SSE may have flipped during the wait).
   *
   * Returns `{ ok: false, reason }` on timeout so the caller can surface a
   * specific `submit_failed` without blindly aborting in-flight work.
   */
  private async waitForPromptReady(
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: "pane_not_idle" | "turn_active" }> {
    const deadline = Date.now() + timeoutMs;

    if (!this._turnStateKnown) {
      const idleDeadline = Math.min(deadline, Date.now() + PANE_IDLE_TIMEOUT_MS);
      if (!(await this.waitForPaneIdle(idleDeadline))) {
        return { ok: false, reason: "pane_not_idle" };
      }
    }

    while (this._turnActive && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this._turnActive) return { ok: false, reason: "turn_active" };

    return { ok: true };
  }

  /**
   * Cold-start TUI readiness: wait for the pane to (a) actually contain
   * rendered TUI markers (`│ >` / shortcuts / banner) and (b) be stable
   * across `PANE_IDLE_STABLE_SAMPLES` consecutive captures. The marker
   * requirement is what we were missing — an empty pane is "stable" but
   * very much not ready: pasting lands in a void before the TUI paints.
   */
  private async waitForPaneIdle(deadline: number): Promise<boolean> {
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PANE_IDLE_SAMPLE_MS));
      const pane = capturePane(this.tmuxName);
      if (!ClaudeCliSession.tuiRendered(pane)) {
        stable = 0;
        last = pane;
        continue;
      }
      if (pane === last) {
        if (++stable >= PANE_IDLE_STABLE_SAMPLES) return true;
      } else {
        stable = 0;
        last = pane;
      }
    }
    return false;
  }

  /**
   * Paste `text` and confirm it landed in the pane. On miss, surface
   * `submit_failed` with `paneTail` and return false — no destructive
   * recovery. The user (or `/restart`) decides next steps.
   */
  /**
   * Paste `text`, submit (Enter), then wait for the proxy to observe an SSE
   * `message_start` event — proof Claude received the input and began a new
   * agent turn. This replaces the older pane-scrape echo gate, which was
   * unreliable for large pastes (Claude consumes the `[Pasted text #N]`
   * placeholder before our 500ms poll window can see it).
   *
   * On timeout, surface `submit_failed` with `paneTail` for diagnostics. No
   * destructive recovery; the caller decides whether to retry or `/restart`.
   */
  private async pasteSubmitAndConfirmTurnStart(text: string): Promise<boolean> {
    const wait = this.waitForTurnStart(TURN_START_TIMEOUT_MS);
    pasteText(this.tmuxName, text);
    await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
    submit(this.tmuxName);
    if (await wait) return true;

    log.error("no SSE turn-start after submit — aborting (no blind recovery)", {
      ...this.stateSnapshot(),
      paneTail: this.paneTail(10),
    });
    this.emit("sse", {
      type: "submit_failed",
      timestamp: new Date().toISOString(),
      reason: "no_turn_start",
      paneTail: this.paneTail(10),
      hint: "Claude didn't start a new turn after submit. The CLI may be busy, rate-limited, or stuck — try again, or send `/restart` to relaunch.",
    } satisfies StreamEvent);
    return false;
  }

  /**
   * Wait up to `timeoutMs` for the next `message_start` agent-turn SSE event.
   * Resolves true on the first such event, false on timeout. Subscribes
   * BEFORE we paste so we never miss a fast-arriving message_start.
   */
  private waitForTurnStart(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onStart = (): void => {
        clearTimeout(timer);
        this.off("turn_started", onStart);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off("turn_started", onStart);
        resolve(false);
      }, timeoutMs);
      this.once("turn_started", onStart);
    });
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

  /**
   * Graceful-shutdown variant: drop our in-process state but DON'T kill the
   * tmux pane or claude process. The next agent-host's `restorePersistedSessions`
   * will call `start()` → `ensureRunning()` → reuse=true (no respawn, no
   * startup probes, no rate-limit risk). The 10-min idle reaper still kills
   * truly idle CLIs via `close()` so this isn't a resource leak.
   */
  async release(): Promise<void> {
    if (!this._isStarted && !this.proxy) return;
    this._isClosed = true;
    this.proxy?.stop();
    this.proxy = null;
    this._isStarted = false;
    this._turnStateKnown = false;
    this.emit("closed");
    log.info("Released (tmux pane preserved)", {
      id: this.id.slice(0, 8),
      tmux: this.tmuxName,
    });
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

    // Any agent-turn event proves we have a live read on the TUI's turn state;
    // future prompts can trust `_turnActive` without re-running pane-idle.
    this._turnStateKnown = true;
    this.lastActivityTime = Date.now();
    const type = event.type;

    if (type === "message_delta") {
      const sr = (event as { delta?: { stop_reason?: string } }).delta?.stop_reason;
      if (sr) this.lastStopReason = sr;
    }

    // `message_start` = Claude began processing a new agent turn. This is the
    // source-of-truth signal that a freshly-submitted prompt landed — the
    // paste flow waits on it instead of pane-scraping for the placeholder.
    if (type === "message_start") {
      this.emit("turn_started");
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
