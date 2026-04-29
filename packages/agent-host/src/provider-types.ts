import type { ThinkingEffort } from "@anima/shared";

/** Emitted runtime event. Anthropic events use native SSE event names; other
 * providers should normalize their stream to the same high-level shape. */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface CreateSessionOptions {
  /** Optional caller-supplied session ID */
  sessionId?: string;
  /** Working directory for the provider runtime */
  cwd: string;
  /** Model to use */
  model?: string;
  /** System prompt or instructions */
  systemPrompt?: string;
  /** Enable adaptive thinking, when supported */
  thinking?: boolean;
  /** Thinking effort level, when supported */
  effort?: ThinkingEffort;
}

export interface ResumeSessionOptions {
  /** Working directory for the provider runtime */
  cwd: string;
  /** Model to use */
  model?: string;
  /** Last observed activity timestamp (ISO) for restore hydration */
  lastActivity?: string;
  /** Enable adaptive thinking, when supported */
  thinking?: boolean;
  /** Thinking effort level, when supported */
  effort?: ThinkingEffort;
}

export interface AgentRuntimeSessionInfo {
  id: string;
  cwd: string;
  model: string;
  isActive: boolean;
  isProcessRunning: boolean;
  createdAt: string;
  lastActivity: string;
  healthy: boolean;
  stale: boolean;
}

export interface AgentRuntimeSession {
  readonly id: string;
  readonly isActive: boolean;
  readonly isProcessRunning: boolean;
  start(): Promise<void>;
  prompt(content: string | unknown[]): Promise<void> | void;
  interrupt(): void;
  close(): Promise<void>;
  setPermissionMode(mode: string): void;
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void;
  getInfo(): AgentRuntimeSessionInfo;
  on(eventName: "sse", listener: (event: StreamEvent) => void): this;
  on(eventName: "process_started" | "process_ended" | "closed", listener: () => void): this;
}

export type AgentRuntimeFactory = {
  create: (options: CreateSessionOptions) => AgentRuntimeSession;
  resume: (sessionId: string, options: ResumeSessionOptions) => AgentRuntimeSession;
};

export type AgentRuntimeProviders = Record<string, AgentRuntimeFactory>;
