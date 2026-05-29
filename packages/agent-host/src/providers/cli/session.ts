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
import { SessionJsonlTail } from "./jsonl-tail";

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
/** Max wait for the feedback survey to clear after we answer it. */
const SURVEY_CLEAR_TIMEOUT_MS = 2_000;
/** Poll interval while waiting for the survey to clear. */
const SURVEY_CLEAR_SAMPLE_MS = 150;

/**
 * Detect the CLI's periodic "How is Claude doing this session?" feedback
 * survey. Matches the distinctive options row — `1: Bad … 3: Good … 0: Dismiss`
 * on a single line — rather than the question text alone, so conversation
 * scrollback that merely *mentions* the survey can't trigger a false positive
 * (which would leak a stray "3" into the next prompt). `.` never crosses a
 * newline, so all three markers must share one captured line, exactly as the
 * TUI renders them.
 */
export function isFeedbackSurvey(pane: string): boolean {
  return /\b1:\s*Bad\b.*\b3:\s*Good\b.*\b0:\s*Dismiss\b/i.test(pane);
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
  /** reqId of the in-flight agent request — the target of post-interrupt suppression. */
  private _activeReqId: string | null = null;
  /**
   * reqIds whose remaining SSE we drop. An interrupted request is NOT cancelled
   * upstream — the TUI stops rendering it but the stream finishes server-side, so
   * the proxy keeps receiving deltas. Suppressing by reqId (not a global flag)
   * means a fresh turn opened during the ~30s drain still streams normally.
   */
  private readonly _suppressedReqIds = new Set<string>();
  /** Tails our own JSONL transcript — the only signal for a direct-tmux interrupt. */
  private readonly tail: SessionJsonlTail;
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
    // A direct-tmux Escape (user typing in an attached pane) never calls
    // interrupt(); the JSONL marker is the only signal that reaches us. Funnel it
    // into the same idempotent abort as the web-UI path.
    this.tail = new SessionJsonlTail(this.cwd, this.id);
    this.tail.on("interrupt", () => this.abortTurn("jsonl_marker"));
    // A prompt is "received" the instant the CLI records it in the transcript —
    // as a `type:"user"` entry (fresh prompt) or a `queue-operation/enqueue`
    // (steer). This is the receipt that confirms a paste landed even when no SSE
    // `message_start` follows (an in-tool steer injected at a tool boundary).
    this.tail.on("user_prompt", () => this.emit("prompt_received"));
    this.tail.on("enqueue", () => this.emit("prompt_received"));
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
    this.tail.start();
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

    // Positive ready signal before pasting: only that the TUI has painted its
    // input box (cold-start bootstrap via pane-idle detection). We do NOT wait
    // for the turn to clear — a busy pane is fine, the CLI queues the paste as a
    // steer. Never sends destructive keys to "unstick" the TUI.
    const ready = await this.waitForPromptReady(PROMPT_READY_TIMEOUT_MS);
    if (!ready.ok) {
      log.warn("TUI not ready for prompt — aborting submit", {
        ...this.stateSnapshot(),
        reason: ready.reason,
      });
      const hint = `The CLI's input box hasn't rendered yet (pane not ready). Attach with \`tmux attach -t ${this.tmuxName}\` to check, then resend.`;
      this.emit("sse", {
        type: "runtime_error",
        subtype: "submit_failed",
        timestamp: new Date().toISOString(),
        reason: ready.reason,
        message: `Your prompt didn't reach Claude (${ready.reason}). ${hint}`,
        paneTail: this.paneTail(10),
        hint,
      } satisfies StreamEvent);
      this.emit("sse", {
        type: "turn_stop",
        timestamp: new Date().toISOString(),
        stop_reason: "submit_failed",
      } satisfies StreamEvent);
      return;
    }

    // Clear (and answer) any feedback survey sitting on the idle input before we
    // paste — its number keys are captured by the survey widget, not the input
    // box, so a lingering survey could swallow our first keystroke.
    await this.answerFeedbackSurveyIfPresent();

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

    // Paste text + submit, then confirm the CLI accepted it — via a fresh turn's
    // `message_start` OR the JSONL receipt for a steer the CLI queues. We defer
    // to the CLI: an idle pane yields a new turn, a busy pane queues the text.
    // No retry-with-Esc — on no receipt we surface submit_failed cleanly.
    if (text.trim()) {
      const landed = await this.pasteSubmitAndConfirm(text);
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
   * Confirm the pane can accept a paste — WITHOUT blocking on turn state. We
   * defer turn handling to the CLI: pasting into an idle pane starts a fresh
   * turn; pasting into a busy pane is queued by the CLI (a steer). The only
   * thing we still guard is the one failure the CLI can't recover from — pasting
   * before the TUI has painted its input box.
   *
   * Cold path only (no SSE seen since start/resume): sample `capture-pane` until
   * the TUI markers render and stabilize. Hot path: we've seen SSE, so the TUI
   * is definitely up — return immediately, busy or not.
   *
   * Returns `{ ok: false, reason }` on timeout so the caller can surface a
   * specific `submit_failed`.
   */
  private async waitForPromptReady(
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: "pane_not_idle" }> {
    if (!this._turnStateKnown) {
      const idleDeadline = Math.min(Date.now() + timeoutMs, Date.now() + PANE_IDLE_TIMEOUT_MS);
      if (!(await this.waitForPaneIdle(idleDeadline))) {
        return { ok: false, reason: "pane_not_idle" };
      }
    }
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
   * The CLI periodically renders a "How is Claude doing this session?" feedback
   * survey (`1: Bad  2: Fine  3: Good  0: Dismiss`) above the idle input box.
   * When present, answer "3" (Good) — both to clear it before we paste (its
   * number keys are captured by the widget, not the input box, so leaving it up
   * could swallow our first keystroke) and to register genuine interactivity
   * with Anthropic. This is NOT blind key injection: we only ever press "3" on a
   * positive on-screen match, and confirm the survey cleared before returning.
   */
  private async answerFeedbackSurveyIfPresent(): Promise<void> {
    if (!isFeedbackSurvey(capturePane(this.tmuxName))) return;
    log.info("feedback survey detected — answering 3 (Good)", { id: this.id.slice(0, 8) });
    sendKey(this.tmuxName, "3");
    const deadline = Date.now() + SURVEY_CLEAR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SURVEY_CLEAR_SAMPLE_MS));
      if (!isFeedbackSurvey(capturePane(this.tmuxName))) return;
    }
    log.warn("feedback survey still present after answering 3", {
      id: this.id.slice(0, 8),
      paneTail: this.paneTail(6),
    });
  }

  /**
   * Paste `text`, submit (Enter), then confirm the CLI accepted it. The send is
   * confirmed by EITHER signal, whichever lands first:
   *   - SSE `message_start` — a fresh agent turn began (idle pane, or a steer the
   *     CLI promoted to a new turn).
   *   - JSONL receipt (`prompt_received`) — the CLI recorded the prompt as a
   *     `user` entry or an `enqueue`. This is the ONLY signal for an in-tool
   *     steer, which the CLI injects at the next tool boundary with no
   *     `message_start` of its own.
   *
   * We never pane-scrape for `[Pasted text #N]` — large pastes consume the
   * placeholder before we can poll. On timeout, surface `submit_failed`; no
   * destructive recovery — the caller (or `/restart`) decides next steps.
   */
  private async pasteSubmitAndConfirm(text: string): Promise<boolean> {
    const wait = this.waitForSendConfirm(TURN_START_TIMEOUT_MS);
    pasteText(this.tmuxName, text);
    await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
    submit(this.tmuxName);
    if (await wait) return true;

    log.error("no send receipt after submit — aborting (no blind recovery)", {
      ...this.stateSnapshot(),
      paneTail: this.paneTail(10),
    });
    const hint =
      "Claude neither started a turn nor recorded the prompt — the CLI may be on a modal prompt, busy, or stuck. " +
      `Attach with \`tmux attach -t ${this.tmuxName}\` to check, or send \`/restart\` to relaunch.`;
    this.emit("sse", {
      type: "runtime_error",
      subtype: "submit_failed",
      timestamp: new Date().toISOString(),
      reason: "no_receipt",
      message: `Your prompt didn't reach Claude (no receipt in ${Math.round(TURN_START_TIMEOUT_MS / 1000)}s). ${hint}`,
      paneTail: this.paneTail(10),
      hint,
    } satisfies StreamEvent);
    return false;
  }

  /**
   * Resolve true when the CLI confirms the just-submitted prompt — on the first
   * of `turn_started` (SSE `message_start`) or `prompt_received` (JSONL `user` /
   * `enqueue`) — or false on timeout. Subscribe BEFORE pasting so a fast receipt
   * is never missed.
   */
  private waitForSendConfirm(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.off("turn_started", done);
        this.off("prompt_received", done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off("turn_started", done);
        this.off("prompt_received", done);
        resolve(false);
      }, timeoutMs);
      this.once("turn_started", done);
      this.once("prompt_received", done);
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
    this.abortTurn("escape");
  }

  /**
   * Abort the in-flight turn — the single funnel for both interrupt paths:
   * web-UI Escape (via interrupt(), after send-keys) and a direct-tmux Escape
   * (via the JSONL `[Request interrupted by user…]` marker the tail detects).
   *
   * The TUI/SDK does NOT cancel the upstream request on Escape — it stops
   * rendering and ignores further events, letting the stream finish server-side
   * (verified: ~33s of deltas kept arriving after the marker). So we record the
   * in-flight reqId in `_suppressedReqIds` and drop its remaining SSE, otherwise
   * those trailing deltas would "un-stop" the UI after our turn_stop.
   *
   * Idempotent: `endTurn()` clears `_turnActive`, so the second caller (whichever
   * of the two paths fires later) no-ops — exactly one turn_stop{abort} per turn.
   */
  private abortTurn(source: string): void {
    if (!this._turnActive) return;
    if (this._activeReqId) this._suppressedReqIds.add(this._activeReqId);
    log.info("turn aborted — suppressing post-interrupt drain", {
      id: this.id.slice(0, 8),
      source,
      reqId: this._activeReqId,
    });
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
    this.tail.stop();
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
    this.tail.stop();
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

    // Post-interrupt drain: an interrupted request finishes server-side even
    // though the TUI stopped. Drop its remainder so the UI doesn't un-stop on
    // trailing deltas; the terminating message_stop retires the reqId.
    if (this._suppressedReqIds.has(ctx.reqId)) {
      if (event.type === "message_stop") this._suppressedReqIds.delete(ctx.reqId);
      return;
    }

    // Any agent-turn event proves we have a live read on the TUI's turn state;
    // future prompts can trust `_turnActive` without re-running pane-idle.
    this._turnStateKnown = true;
    this.lastActivityTime = Date.now();
    this._activeReqId = ctx.reqId;
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
