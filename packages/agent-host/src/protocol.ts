/**
 * Agent Host WebSocket Protocol
 *
 * Type definitions for all messages between extension clients and the agent-host server.
 * Uses the same { type, ... } envelope pattern as the gateway and extension-host protocols.
 */

// ── Client → Server Messages ─────────────────────────────────

/** Identify which extension is connecting and which sessions to resume */
export interface AuthMessage {
  type: "auth";
  extensionId: string; // "session" or "codex"
  /** Sessions to subscribe to and replay events for (reconnect scenario) */
  resumeSessions?: Array<{ sessionId: string; lastSeq: number }>;
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
  };
}

/** Send a prompt to an existing session */
export interface PromptMessage {
  type: "session.prompt";
  requestId: string;
  sessionId: string;
  content: string | unknown[];
  cwd?: string; // for auto-resume
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

/** Union of all client-to-server messages */
export type ClientMessage =
  | AuthMessage
  | CreateSessionMessage
  | PromptMessage
  | InterruptMessage
  | CloseMessage
  | SetPermissionModeMessage
  | SendToolResultMessage
  | ListSessionsMessage;

// ── Server → Client Messages ─────────────────────────────────

/** Response to a request (success or error) */
export interface ResponseMessage {
  type: "res";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** Streaming event from an SDK session */
export interface SessionEventMessage {
  type: "session.event";
  sessionId: string;
  event: {
    type: string; // "message_start", "content_block_delta", "turn_stop", etc.
    [key: string]: unknown;
  };
  /** Monotonic sequence number within the session, for gap detection on reconnect */
  seq: number;
}

/** Union of all server-to-client messages */
export type ServerMessage = ResponseMessage | SessionEventMessage;
