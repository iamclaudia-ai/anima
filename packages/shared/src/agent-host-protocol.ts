/**
 * Agent Host WebSocket Protocol
 *
 * Shared types for messages between extensions and agent-host.
 */

// ── Client → Server Messages ─────────────────────────────────

/** Identify which extension is connecting and which sessions to resume */
export interface AuthMessage {
  type: "auth";
  extensionId: string; // "session" or "codex"
  /** Sessions to subscribe to and replay events for (reconnect scenario) */
  resumeSessions?: Array<{ sessionId: string; lastSeq: number }>;
  /** Tasks to subscribe to and replay events for (reconnect scenario) */
  resumeTasks?: Array<{ taskId: string; lastSeq: number }>;
}

/** Create a new SDK session */
export interface CreateSessionMessage {
  type: "session.create";
  requestId: string;
  params: {
    cwd: string;
    model?: string;
    systemPrompt?: string;
    thinking?: boolean;
    effort?: string;
    agent?: string;
  };
}

/** Send a prompt to an existing session */
export interface PromptMessage {
  type: "session.prompt";
  requestId: string;
  sessionId: string;
  content: string | unknown[];
  cwd?: string; // for auto-resume
  agent?: string;
}

/** Interrupt a session */
export interface InterruptMessage {
  type: "session.interrupt";
  requestId: string;
  sessionId: string;
}

/** Close a session */
export interface CloseMessage {
  type: "session.close";
  requestId: string;
  sessionId: string;
}

/** Set permission mode */
export interface SetPermissionModeMessage {
  type: "session.set_permission_mode";
  requestId: string;
  sessionId: string;
  mode: string;
}

/** Send tool result */
export interface SendToolResultMessage {
  type: "session.send_tool_result";
  requestId: string;
  sessionId: string;
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** List active sessions managed by agent-host */
export interface ListSessionsMessage {
  type: "session.list";
  requestId: string;
}

/** Start a delegated task on a target agent/provider */
export interface TaskStartMessage {
  type: "task.start";
  requestId: string;
  params: {
    sessionId: string;
    agent: string;
    prompt: string;
    mode?: string;
    cwd?: string;
    model?: string;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    files?: string[];
    metadata?: Record<string, unknown>;
  };
}

/** Get a delegated task by ID */
export interface TaskGetMessage {
  type: "task.get";
  requestId: string;
  taskId: string;
}

/** List delegated tasks with optional filters */
export interface TaskListMessage {
  type: "task.list";
  requestId: string;
  sessionId?: string;
  status?: string;
  agent?: string;
}

/** Interrupt a delegated task by ID */
export interface TaskInterruptMessage {
  type: "task.interrupt";
  requestId: string;
  taskId: string;
}

/** Union of all client-to-server messages */
export type AgentHostClientMessage =
  | AuthMessage
  | CreateSessionMessage
  | PromptMessage
  | InterruptMessage
  | CloseMessage
  | SetPermissionModeMessage
  | SendToolResultMessage
  | ListSessionsMessage
  | TaskStartMessage
  | TaskGetMessage
  | TaskListMessage
  | TaskInterruptMessage;

// ── Server → Client Messages ─────────────────────────────────

/** Response to a request (success or error) */
export interface AgentHostResponseMessage {
  type: "res";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** Streaming event from an SDK session */
export interface AgentHostSessionEventMessage {
  type: "session.event";
  sessionId: string;
  event: {
    type: string; // "message_start", "content_block_delta", "turn_stop", etc.
    [key: string]: unknown;
  };
  /** Monotonic sequence number within the session, for gap detection on reconnect */
  seq: number;
}

/** Streaming event from a delegated task */
export interface AgentHostTaskEventMessage {
  type: "task.event";
  taskId: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
  /** Monotonic sequence number within the task, for gap detection on reconnect */
  seq: number;
}

/** Union of all server-to-client messages */
export type AgentHostServerMessage =
  | AgentHostResponseMessage
  | AgentHostSessionEventMessage
  | AgentHostTaskEventMessage;
