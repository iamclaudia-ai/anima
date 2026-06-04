/**
 * Anthropic tee proxy for the Claude CLI runtime (#33).
 *
 * The real `claude` CLI runs in a tmux pane with `ANTHROPIC_BASE_URL` pointed
 * here. We forward every request to the real Anthropic API verbatim (preserving
 * the OAuth subscription token) and `tee()` the response: one branch streams
 * back to the CLI untouched, the other is parsed for SSE events we surface to
 * the session-host event bus.
 *
 * PR 1: plain-HTTP pass-through (base-URL mode). TLS MITM is Phase 2 and slots
 * in behind the same `onEvent` contract.
 */

import { createLogger } from "@anima/shared";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, statSync } from "node:fs";
import {
  createServer as netServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "../../provider-types";

const log = createLogger("CliProxy", join(homedir(), ".anima", "logs", "agent-host.log"));

const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * Full request + response capture sink — one JSON line per request, written only
 * when the `capture` option is on. Lets us classify agent vs auxiliary calls
 * (title-gen, suggestion, topic, quota) by FACT instead of heuristic: grep the
 * generated text, then read that line's request to see what marks it.
 */
const CAPTURE_FILE = join(homedir(), ".anima", "logs", "cli-proxy-capture.jsonl");

/**
 * Per-event SSE capture sink — one JSON line per SSE event (not a giant inline
 * array), so the stream is readable and greppable. Each line carries `reqId`
 * (correlates back to the CAPTURE_FILE request line) plus the raw event.
 */
const EVENTS_FILE = join(homedir(), ".anima", "logs", "cli-proxy-events.jsonl");

/**
 * Hard size cap per capture sink. Capture is a debug aid gated behind the
 * `capture` option; this guarantees a sink can never grow unbounded even if the
 * flag is left on — the 3.7GB incident (#50) that prompted this. Past the cap we
 * stop appending and warn once.
 */
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
const cappedWarned = new Set<string>();

/** Per-stream context derived from the originating request. */
export interface StreamContext {
  /**
   * True when the request is a real agent turn (carries the Claude Code toolset
   * and full system prompt) vs an auxiliary call — title-gen, the `max_tokens:1`
   * quota probe, topic detection — that must be kept out of the chat.
   */
  isAgentTurn: boolean;
  /** Short per-request id — lets consumers correlate or suppress a single request's stream. */
  reqId: string;
}

export interface TeeProxyOptions {
  /** Preferred port; the proxy probes upward if it is taken. */
  port: number;
  /** Called for each parsed SSE event from the model stream. */
  onEvent: (event: StreamEvent, ctx: StreamContext) => void;
  /** Called with each parsed JSON request body (for tool_result extraction). */
  onRequestBody?: (body: unknown, ctx: StreamContext) => void;
  /** When true, append full request + response JSON to CAPTURE_FILE. */
  capture?: boolean;
  /**
   * Base model id (suffix-stripped, e.g. `claude-opus-4-8`) the session selected
   * the 1M-context variant for. When set, the proxy injects the 1M-context beta
   * into a forwarded request's `anthropic-beta` header ONLY when that request's
   * own model is this model — letting us pass the bare model id (avoiding the
   * CLI's broken `[1m]` preflight 404) while keeping the 1M window.
   *
   * The 1M beta is an Opus-tier feature: blindly injecting it onto subagent /
   * auxiliary calls that run on a different model (e.g. the Haiku Task subagent)
   * makes the API 400 "long context beta not yet available for this
   * subscription" (#60). Gating on the per-request model is what prevents that.
   */
  context1mModel?: string;
  /**
   * Transport. "base-url" (default) serves plain HTTP and the CLI targets it via
   * ANTHROPIC_BASE_URL. "mitm" runs an HTTPS_PROXY-style CONNECT proxy that
   * TLS-terminates api.anthropic.com (needs `tls`) and blind-tunnels every other
   * host — no ANTHROPIC_BASE_URL required.
   */
  interception?: "base-url" | "mitm";
  /** Leaf key+cert (PEM) for the inner TLS server. Required for "mitm". */
  tls?: { key: string; cert: string };
}

/** Anthropic beta flag that enables the 1M-token context window. */
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** Strip a trailing `[...]` model-variant suffix (e.g. `[1m]`) for comparison. */
function stripVariant(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, "").trim();
}

/**
 * Decide whether a forwarded request should carry the 1M-context beta. True only
 * when the session selected a 1M model (`context1mModel` set) AND this request's
 * own model is that same model. Subagent / auxiliary calls on a different model
 * (Haiku Task subagent, etc.) return false — they must not carry an Opus-tier
 * beta the subscription won't honor for them (#60). Model-less requests (HEAD
 * probes, count_tokens without a model) also return false: there's nothing to
 * apply the 1M window to.
 */
export function shouldInjectContext1m(
  requestModel: unknown,
  context1mModel: string | undefined,
): boolean {
  if (!context1mModel) return false;
  if (typeof requestModel !== "string" || !requestModel) return false;
  return stripVariant(requestModel) === stripVariant(context1mModel);
}

/** The one host we decrypt; everything else is blind-tunneled untouched. */
const MITM_HOST = "api.anthropic.com";

/**
 * Concatenate the text of the final user message — used to sniff internal
 * maintenance calls that masquerade as agent turns (see isCompactionRequest).
 */
function lastUserText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const last = messages[messages.length - 1] as { role?: string; content?: unknown };
  if (last?.role !== "user") return "";
  if (typeof last.content === "string") return last.content;
  if (!Array.isArray(last.content)) return "";
  return (last.content as Array<Record<string, unknown>>)
    .map((b) => (b && typeof b === "object" ? String(b.text ?? "") : ""))
    .join(" ");
}

/**
 * Internal maintenance calls that reuse the FULL agent toolset + system prompt
 * (so tools/system can't tell them apart from a real turn) but inject a
 * recognizable instruction as the final user message. Both confirmed by capture:
 *
 *   - Auto-compaction: "...create a detailed summary of the conversation..." →
 *     streams an `<analysis>`/`<summary>` blob.
 *   - Suggestion mode: "[SUGGESTION MODE: Suggest what the user might naturally
 *     type next...]" → streams a predicted *user* prompt (e.g. "reloaded, let's
 *     test again"), which previously leaked into chat as an assistant message.
 *
 * Their output must stay OUT of the chat.
 */
function isMaintenanceRequest(body: unknown): boolean {
  const text = lastUserText(body);
  return (
    /create a detailed summary of the conversation/i.test(text) || /\[SUGGESTION MODE:/i.test(text)
  );
}

/**
 * Distinguish a real agent turn from Claude Code's internal calls. Two facts,
 * both verified against the proxy capture:
 *   1. Real turns always carry the Claude Code toolset; auxiliary calls
 *      (title-gen, the `max_tokens:1` quota probe, topic/count_tokens) send no
 *      tools.
 *   2. Compaction and suggestion-mode DO carry the toolset, so tools alone is
 *      insufficient — they are excluded by their final-user-message signature.
 */
function isAgentRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { tools?: unknown };
  if (!Array.isArray(b.tools) || b.tools.length === 0) return false;
  if (isMaintenanceRequest(body)) return false;
  return true;
}

/**
 * Summarize auth-bearing headers WITHOUT leaking the secret — so the request log
 * tells us whether the CLI is authenticating (and how) without writing tokens to
 * disk. This is the key diagnostic for the base-URL-vs-OAuth question: if both
 * `authorization` and `x-api-key` are `false`, the CLI is sending the request
 * unauthenticated (api.anthropic.com will answer 401).
 */
function authSummary(h: Headers): Record<string, string | boolean> {
  const authz = h.get("authorization");
  const apiKey = h.get("x-api-key");
  const beta = h.get("anthropic-beta");
  return {
    authorization: authz ? `${authz.split(" ")[0] || "?"}(len=${authz.length})` : false,
    xApiKey: apiKey ? `present(len=${apiKey.length})` : false,
    anthropicBeta: beta ?? false,
  };
}

/** Dump all headers for capture, masking only the secret-bearing ones. */
function dumpHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h) {
    const lk = k.toLowerCase();
    out[k] =
      lk === "authorization" || lk === "x-api-key" || lk === "cookie"
        ? `${v.slice(0, 8)}…(len=${v.length})`
        : v;
  }
  return out;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class AnthropicTeeProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** Inner TLS origin server (mitm mode) — same handle() as base-url mode. */
  private innerServer: ReturnType<typeof Bun.serve> | null = null;
  /** Outer CONNECT proxy (mitm mode). */
  private connectServer: Server | null = null;
  private _port = 0;

  constructor(private readonly opts: TeeProxyOptions) {}

  get port(): number {
    return this._port;
  }

  /** Start listening; resolves to the actual bound port the CLI should target. */
  async start(): Promise<number> {
    if (this.opts.interception === "mitm") {
      this._port = await this.startMitm();
      return this._port;
    }
    this._port = this.startBaseUrl();
    return this._port;
  }

  /** base-url transport: a plain-HTTP origin the CLI hits via ANTHROPIC_BASE_URL. */
  private startBaseUrl(): number {
    let port = this.opts.port;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        this.server = Bun.serve({
          port,
          idleTimeout: 0, // never time out long-lived SSE streams
          fetch: (req) => this.handle(req),
        });
        return port;
      } catch (err) {
        const s = String(err);
        if (s.includes("EADDRINUSE") || s.includes("in use") || s.includes("address already")) {
          port++;
          continue;
        }
        throw err;
      }
    }
    throw new Error("CliProxy: no available port");
  }

  /**
   * mitm transport: an inner Bun.serve TLS origin (reusing handle()) plus an
   * outer CONNECT proxy. Bun can't drive a TLS handshake on a hijacked socket
   * (the Node `emit("connection")` trick fails), so we pipe the CONNECT'd socket
   * into the inner TLS listener, which terminates TLS natively. Returns the outer
   * port (what goes in HTTPS_PROXY).
   */
  private async startMitm(): Promise<number> {
    if (!this.opts.tls) throw new Error("CliProxy: mitm interception requires tls key+cert");
    this.innerServer = Bun.serve({
      port: 0, // ephemeral; the CLI never targets it directly
      tls: this.opts.tls,
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
    const innerPort = this.innerServer.port;
    if (innerPort == null) throw new Error("CliProxy: inner TLS server has no port");
    return this.listenConnect(innerPort);
  }

  /** Bind the outer CONNECT proxy, probing upward from opts.port on EADDRINUSE. */
  private listenConnect(innerPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const base = this.opts.port;
      const tryListen = (port: number): void => {
        const srv = netServer((socket) => this.onConnect(socket, innerPort));
        srv.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && port < base + 50) tryListen(port + 1);
          else reject(err);
        });
        srv.listen(port, "127.0.0.1", () => {
          this.connectServer = srv;
          resolve(port);
        });
      };
      tryListen(base);
    });
  }

  /**
   * Handle one CONNECT tunnel: api.anthropic.com is piped into the inner TLS
   * listener (decrypt + tee); any other host is blind-tunneled to its real
   * origin. The CLI waits for our 200 before sending TLS bytes, so the single
   * CONNECT chunk never carries trailing payload.
   */
  private onConnect(socket: Socket, innerPort: number): void {
    socket.once("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").split("\r\n")[0];
      const m = /^CONNECT\s+([^:]+):(\d+)/i.exec(line);
      if (!m) {
        socket.end();
        return;
      }
      const host = m[1];
      const port = Number(m[2]);
      const mitm = host === MITM_HOST;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const up = netConnect(mitm ? innerPort : port, mitm ? "127.0.0.1" : host, () => {
        socket.pipe(up);
        up.pipe(socket);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });
    socket.on("error", () => {});
  }

  stop(): void {
    this.server?.stop(true);
    this.innerServer?.stop(true);
    this.connectServer?.close();
    this.server = null;
    this.innerServer = null;
    this.connectServer = null;
  }

  /** Append a full request/response record to the capture file (best-effort). */
  private capture(record: Record<string, unknown>): void {
    if (!this.opts.capture) return;
    this.appendCapped(CAPTURE_FILE, JSON.stringify(record) + "\n");
  }

  /** Append a single SSE event to the events file, one per line (best-effort). */
  private captureEvent(record: Record<string, unknown>): void {
    if (!this.opts.capture) return;
    this.appendCapped(EVENTS_FILE, JSON.stringify(record) + "\n");
  }

  /**
   * Best-effort append to a capture sink with a hard size cap (#50). Once a sink
   * reaches MAX_CAPTURE_BYTES we stop writing and warn once — capture is a debug
   * aid and must never fill the disk, even if `capture` is left on.
   */
  private appendCapped(file: string, line: string): void {
    try {
      if (existsSync(file) && statSync(file).size >= MAX_CAPTURE_BYTES) {
        if (!cappedWarned.has(file)) {
          cappedWarned.add(file);
          log.warn("capture sink hit size cap — halting writes", {
            file,
            capBytes: MAX_CAPTURE_BYTES,
          });
        }
        return;
      }
      appendFileSync(file, line);
    } catch {
      // capture is best-effort debug aid — never let it break the proxy
    }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.set("accept-encoding", "identity");

    const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
    const body = hasBody ? await req.arrayBuffer() : undefined;

    let parsed: unknown = null;
    if (body) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        // non-JSON body — ignore
      }
    }

    // Keep the 1M context window without sending the CLI's broken `[1m]` model
    // id: merge the beta flag into whatever `anthropic-beta` list is present —
    // but ONLY for this session's 1M model. Injecting it onto a subagent's Haiku
    // request (a different model) 400s "long context beta not available" (#60).
    const reqModel =
      parsed && typeof parsed === "object" ? (parsed as { model?: unknown }).model : undefined;
    if (shouldInjectContext1m(reqModel, this.opts.context1mModel)) {
      const betas = new Set(
        (headers.get("anthropic-beta") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      betas.add(CONTEXT_1M_BETA);
      headers.set("anthropic-beta", [...betas].join(","));
    }

    const ctx: StreamContext = {
      isAgentTurn: isAgentRequest(parsed),
      reqId: randomUUID().slice(0, 8),
    };
    if (parsed && this.opts.onRequestBody) this.opts.onRequestBody(parsed, ctx);

    // Strip the Anima `[1m]` variant from the model on the wire: the CLI keeps it
    // for its own 1M context accounting (meter + compaction threshold), but
    // api.anthropic.com rejects it (404). The 1M window is carried by the beta
    // header injected above. `parsed` is left untouched so capture shows what the
    // CLI actually sent.
    let forwardBody: ArrayBuffer | string | undefined = body;
    if (typeof reqModel === "string" && /\[[^\]]*\]\s*$/.test(reqModel)) {
      forwardBody = JSON.stringify({
        ...(parsed as Record<string, unknown>),
        model: stripVariant(reqModel),
      });
    }

    log.info("→ request", {
      method: req.method,
      path: url.pathname,
      agentTurn: ctx.isAgentTurn,
      model: typeof reqModel === "string" ? reqModel : undefined,
      auth: authSummary(headers),
    });

    // Capture metadata carried into all response branches (one line per request).
    const reqId = ctx.reqId;
    const reqMeta: Record<string, unknown> = {
      ts: new Date().toISOString(),
      reqId,
      port: this._port,
      method: req.method,
      path: url.pathname + url.search,
      isAgentTurn: ctx.isAgentTurn,
      model: typeof reqModel === "string" ? reqModel : undefined,
      reqHeaders: dumpHeaders(headers),
      request: parsed ?? (body ? "(non-JSON body)" : null),
    };

    let upstream: Response;
    try {
      upstream = await fetch(ANTHROPIC_API + url.pathname + url.search, {
        method: req.method,
        headers,
        body: forwardBody,
      });
    } catch (err) {
      log.warn("upstream fetch failed", { error: String(err) });
      this.capture({ ...reqMeta, error: String(err) });
      return new Response("proxy upstream error", { status: 502 });
    }

    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");

    const ct = upstream.headers.get("content-type") || "";
    log.info("← upstream", { status: upstream.status, ct: ct.split(";")[0] || "(none)" });

    // Non-OK responses are short and crucial for diagnosis (401/403 auth, 400
    // bad model, 429 quota). Read the body, log a snippet, and pass it through.
    if (!upstream.ok) {
      const errText = await upstream.text();
      log.warn("← upstream error body", { status: upstream.status, body: errText.slice(0, 800) });
      this.capture({ ...reqMeta, status: upstream.status, ct, responseBody: tryJson(errText) });
      return new Response(errText, { status: upstream.status, headers: outHeaders });
    }

    if (ct.includes("text/event-stream") && upstream.body) {
      log.info("← SSE stream start", { agentTurn: ctx.isAgentTurn });
      const [logStream, passStream] = upstream.body.tee();
      void this.consume(logStream, ctx, { ...reqMeta, status: upstream.status, ct });
      return new Response(passStream, { status: upstream.status, headers: outHeaders });
    }

    // Non-SSE OK responses (e.g. count_tokens) — read for capture, then forward.
    const text = await upstream.text();
    this.capture({ ...reqMeta, status: upstream.status, ct, responseBody: tryJson(text) });
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }

  private async consume(
    stream: ReadableStream<Uint8Array>,
    ctx: StreamContext,
    capMeta: Record<string, unknown>,
  ): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // Streaming-vs-buffered instrumentation: if firstDeltaMs ≪ totalMs (deltas
    // spread over many reads), the stream is genuinely incremental. If they
    // cluster at the end, something upstream is buffering the whole response.
    const t0 = performance.now();
    let firstDeltaMs = -1;
    let deltas = 0;
    let reads = 0;
    // Full-capture accumulators (only populated when capture is on).
    const cap = this.opts.capture === true;
    const reqId = capMeta.reqId;
    let eventCount = 0;
    let assembled = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reads++;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const ev = JSON.parse(data) as StreamEvent;
            if ((ev as { type?: string }).type === "content_block_delta") {
              deltas++;
              if (firstDeltaMs < 0) firstDeltaMs = Math.round(performance.now() - t0);
            }
            if (cap) {
              const d = (ev as { delta?: { type?: string; text?: string } }).delta;
              if (d?.type === "text_delta" && d.text) assembled += d.text;
              this.captureEvent({
                reqId,
                seq: eventCount++,
                isAgentTurn: ctx.isAgentTurn,
                type: (ev as { type?: string }).type,
                event: ev,
              });
            }
            this.opts.onEvent(ev, ctx);
          } catch {
            // partial / non-JSON data line — ignore
          }
        }
      }
    } catch (err) {
      log.warn("SSE consume error", { error: String(err) });
    }
    if (ctx.isAgentTurn) {
      log.info("← SSE complete", {
        deltas,
        reads,
        firstDeltaMs,
        totalMs: Math.round(performance.now() - t0),
      });
    }
    // responseEvents live one-per-line in EVENTS_FILE (correlate via reqId);
    // the request line keeps only the assembled text + an event count.
    this.capture({ ...capMeta, responseText: assembled, eventCount });
  }
}
