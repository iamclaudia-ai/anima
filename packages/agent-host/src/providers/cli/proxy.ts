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
import { homedir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "../../provider-types";

const log = createLogger("CliProxy", join(homedir(), ".anima", "logs", "agent-host.log"));

const ANTHROPIC_API = "https://api.anthropic.com";

/** Per-stream context derived from the originating request. */
export interface StreamContext {
  /**
   * True when the request is a real agent turn (carries the Claude Code toolset
   * and full system prompt) vs an auxiliary call — title-gen, the `max_tokens:1`
   * quota probe, topic detection — that must be kept out of the chat.
   */
  isAgentTurn: boolean;
}

export interface TeeProxyOptions {
  /** Preferred port; the proxy probes upward if it is taken. */
  port: number;
  /** Called for each parsed SSE event from the model stream. */
  onEvent: (event: StreamEvent, ctx: StreamContext) => void;
  /** Called with each parsed JSON request body (for tool_result extraction). */
  onRequestBody?: (body: unknown, ctx: StreamContext) => void;
}

/**
 * Distinguish a real agent turn from Claude Code's auxiliary calls. The agent
 * loop always sends the full toolset and a large system prompt; title-gen, the
 * `max_tokens:1` quota probe, and topic detection send neither.
 */
function isAgentRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { tools?: unknown; system?: unknown };
  if (Array.isArray(b.tools) && b.tools.length > 0) return true;
  const sys = b.system;
  const sysLen =
    typeof sys === "string" ? sys.length : Array.isArray(sys) ? JSON.stringify(sys).length : 0;
  return sysLen > 5000;
}

export class AnthropicTeeProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private _port = 0;

  constructor(private readonly opts: TeeProxyOptions) {}

  get port(): number {
    return this._port;
  }

  /** Start listening; returns the actual bound port. */
  start(): number {
    let port = this.opts.port;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        this.server = Bun.serve({
          port,
          idleTimeout: 0, // never time out long-lived SSE streams
          fetch: (req) => this.handle(req),
        });
        this._port = port;
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

  stop(): void {
    this.server?.stop(true);
    this.server = null;
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
    const ctx: StreamContext = { isAgentTurn: isAgentRequest(parsed) };
    if (parsed && this.opts.onRequestBody) this.opts.onRequestBody(parsed, ctx);

    let upstream: Response;
    try {
      upstream = await fetch(ANTHROPIC_API + url.pathname + url.search, {
        method: req.method,
        headers,
        body,
      });
    } catch (err) {
      log.warn("upstream fetch failed", { error: String(err) });
      return new Response("proxy upstream error", { status: 502 });
    }

    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");

    const ct = upstream.headers.get("content-type") || "";
    if (ct.includes("text/event-stream") && upstream.body) {
      const [logStream, passStream] = upstream.body.tee();
      void this.consume(logStream, ctx);
      return new Response(passStream, { status: upstream.status, headers: outHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  private async consume(stream: ReadableStream<Uint8Array>, ctx: StreamContext): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            this.opts.onEvent(JSON.parse(data) as StreamEvent, ctx);
          } catch {
            // partial / non-JSON data line — ignore
          }
        }
      }
    } catch (err) {
      log.warn("SSE consume error", { error: String(err) });
    }
  }
}
