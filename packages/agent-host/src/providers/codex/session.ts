import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@anima/shared";
import type {
  AgentRuntimeSessionInfo,
  CreateSessionOptions,
  ResumeSessionOptions,
  StreamEvent,
} from "../../provider-types";

const log = createLogger("CodexSession", join(homedir(), ".anima", "logs", "agent-host.log"));

export interface CodexProviderConfig {
  apiKey?: string;
  cliPath?: string;
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  autoApprove?: boolean;
  cwd?: string;
  createClient?: () => Promise<CodexClient> | CodexClient;
}

type CodexClient = {
  startThread(options: Record<string, unknown>): {
    runStreamed(
      prompt: string,
      options?: { signal?: AbortSignal },
    ): Promise<{
      events: AsyncIterable<any>;
    }>;
  };
};

function promptToText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const rec = block as Record<string, unknown>;
      if (rec.type === "text") return String(rec.text ?? rec.content ?? "");
      if (rec.type === "document") return `[document:${String(rec.filename ?? "attachment")}]`;
      if (rec.type === "image") return "[image attachment]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeEffort(
  effort: string | undefined,
  fallback: CodexProviderConfig["effort"],
): CodexProviderConfig["effort"] {
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  if (effort === "max") return "xhigh";
  return fallback || "medium";
}

async function loadCodex(config: CodexProviderConfig): Promise<CodexClient> {
  if (config.createClient) return await config.createClient();

  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Codex API key missing for codex session provider");

  const candidates = [
    join(process.cwd(), "node_modules", "@openai", "codex-sdk"),
    join(process.cwd(), "node_modules", ".bun", "node_modules", "@openai", "codex-sdk"),
  ];

  let moduleImpl: { Codex?: new (opts: Record<string, unknown>) => CodexClient } | null = null;
  for (const candidate of candidates) {
    try {
      moduleImpl = (await import(candidate)) as {
        Codex?: new (opts: Record<string, unknown>) => CodexClient;
      };
      break;
    } catch {
      // try next
    }
  }
  if (!moduleImpl?.Codex) {
    throw new Error("Failed to load @openai/codex-sdk for codex session provider");
  }

  return new moduleImpl.Codex({
    apiKey,
    ...(config.cliPath ? { codexPathOverride: config.cliPath } : {}),
  });
}

export class CodexSession extends EventEmitter {
  readonly id: string;

  private _isStarted = false;
  private _isClosed = false;
  private client: CodexClient | null = null;
  private thread: ReturnType<CodexClient["startThread"]> | null = null;
  private abortController: AbortController | null = null;
  private createdAt = Date.now();
  private lastActivityTime = Date.now();
  private runningPrompt = false;

  private cwd: string;
  private model: string;

  constructor(
    id: string,
    options: CreateSessionOptions | ResumeSessionOptions,
    private readonly config: CodexProviderConfig = {},
  ) {
    super();
    this.id = id;
    this.cwd = options.cwd || config.cwd || process.cwd();
    this.model = options.model || config.model || "gpt-5.2-codex";

    const resumeActivity =
      "lastActivity" in options && typeof options.lastActivity === "string"
        ? Date.parse(options.lastActivity)
        : NaN;
    if (Number.isFinite(resumeActivity) && resumeActivity > 0) {
      this.lastActivityTime = resumeActivity;
    }
  }

  async start(): Promise<void> {
    if (this._isStarted) throw new Error("Session already started");
    this._isStarted = true;
    this._isClosed = false;
    this.emit("ready", { sessionId: this.id });
  }

  async prompt(content: string | unknown[]): Promise<void> {
    if (!this._isStarted) throw new Error("Session not started");
    if (this.runningPrompt) throw new Error("Codex session already has a running prompt");

    const prompt = promptToText(content);
    if (!prompt.trim()) return;

    this.runningPrompt = true;
    this.abortController = new AbortController();
    this.client ||= await loadCodex(this.config);
    this.thread ||= this.client.startThread({
      workingDirectory: this.cwd,
      skipGitRepoCheck: true,
      model: this.model,
      sandboxMode: this.config.sandboxMode || "workspace-write",
      modelReasoningEffort: normalizeEffort(undefined, this.config.effort),
      approvalPolicy: this.config.autoApprove === false ? "on-request" : "never",
      webSearchEnabled: false,
    });

    this.emit("process_started");
    void this.runPrompt(prompt, this.abortController);
  }

  interrupt(): void {
    this.abortController?.abort();
    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: "abort",
    } satisfies StreamEvent);
  }

  async close(): Promise<void> {
    this._isClosed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.client = null;
    this._isStarted = false;
    this.emit("closed");
  }

  setPermissionMode(_mode: string): void {}

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {}

  get isActive(): boolean {
    return this._isStarted && !this._isClosed;
  }

  get isProcessRunning(): boolean {
    return this.thread !== null || this.runningPrompt;
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
      healthy: this.isActive && !this._isClosed,
      stale: Date.now() - this.lastActivityTime >= 5 * 60 * 1000,
    };
  }

  private async runPrompt(prompt: string, abortController: AbortController): Promise<void> {
    let blockOpen = false;
    const lastTextByItem = new Map<string, string>();

    try {
      this.emit("sse", { type: "message_start" } satisfies StreamEvent);
      this.emit("sse", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      } satisfies StreamEvent);
      blockOpen = true;

      const run = await this.thread!.runStreamed(prompt, { signal: abortController.signal });
      for await (const event of run.events) {
        this.lastActivityTime = Date.now();
        if (event.type !== "item.updated" && event.type !== "item.completed") continue;
        const item = event.item;
        if (!item || item.type !== "agent_message") continue;

        const id = String(item.id || "agent_message");
        const text = String(item.text || "");
        const previous = lastTextByItem.get(id) || "";
        const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
        lastTextByItem.set(id, text);
        if (!delta) continue;

        this.emit("sse", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta },
        } satisfies StreamEvent);
      }

      if (blockOpen) {
        this.emit("sse", { type: "content_block_stop", index: 0 } satisfies StreamEvent);
        blockOpen = false;
      }
      this.emit("sse", { type: "message_stop" } satisfies StreamEvent);
      this.emit("sse", {
        type: "turn_stop",
        timestamp: new Date().toISOString(),
        stop_reason: "end_turn",
      } satisfies StreamEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted =
        abortController.signal.aborted ||
        message.toLowerCase().includes("abort") ||
        message.toLowerCase().includes("cancel");

      if (blockOpen) {
        this.emit("sse", { type: "content_block_stop", index: 0 } satisfies StreamEvent);
      }
      this.emit("sse", {
        type: aborted ? "turn_stop" : "process_died",
        timestamp: new Date().toISOString(),
        ...(aborted ? { stop_reason: "abort" } : { reason: message }),
      } satisfies StreamEvent);
      if (!aborted) {
        log.warn("Codex prompt failed", { sessionId: this.id.slice(0, 8), error: message });
      }
    } finally {
      this.runningPrompt = false;
      this.abortController = null;
      this.emit("process_ended");
    }
  }
}

export function createCodexSession(
  options: CreateSessionOptions,
  config?: CodexProviderConfig,
): CodexSession {
  const id = options.sessionId || randomUUID();
  return new CodexSession(id, options, config);
}

export function resumeCodexSession(
  sessionId: string,
  options: ResumeSessionOptions,
  config?: CodexProviderConfig,
): CodexSession {
  return new CodexSession(sessionId, options, config);
}

export function createCodexProvider(config: CodexProviderConfig = {}) {
  return {
    create: (options: CreateSessionOptions): CodexSession => createCodexSession(options, config),
    resume: (sessionId: string, options: ResumeSessionOptions): CodexSession =>
      resumeCodexSession(sessionId, options, config),
  };
}
