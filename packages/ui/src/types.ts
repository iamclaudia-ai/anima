// UI-specific types for message display

export interface TextBlock {
  type: "text" | "thinking";
  content: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string; // base64
}

export interface FileBlock {
  type: "file";
  mediaType: string;
  data: string; // base64
  filename?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: string;
  result?: {
    content: string;
    is_error?: boolean;
  };
}

export interface ErrorBlock {
  type: "error";
  message: string;
  status?: number;
  isRetrying?: boolean;
  attempt?: number;
  maxRetries?: number;
  retryInMs?: number;
}

/**
 * A modal the CLI is blocked on (#69) — a hook confirmation, the folder-trust
 * dialog. Rendered in place of the tool call it's gating, since that's where
 * the context for answering it is.
 *
 * Lives in the message stream but is not a transcript entry: it starts live and
 * becomes history the moment it's answered, which is what `answered` /
 * `dismissed` record. Without them a scrolled-back block would keep offering
 * buttons for a question that was settled an hour ago.
 */
export interface ModalPromptBlock {
  type: "modal_prompt";
  kind: "approval" | "input";
  question: string;
  /** The modal's body as the TUI rendered it — command, hook reason, question. */
  context: string[];
  options: Array<{ key: string; label: string }>;
  fingerprint: string;
  /** Option key we sent, once answered. */
  answered?: string;
  /** True when the prompt went away without us answering (someone used tmux). */
  dismissed?: boolean;
  /** Set when an answer was rejected — stale prompt, or it didn't clear. */
  error?: string;
  /** True between clicking an option and hearing back. */
  pending?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | FileBlock
  | ToolUseBlock
  | ErrorBlock
  | ModalPromptBlock;

export interface Message {
  role: "user" | "assistant" | "compaction_boundary";
  blocks: ContentBlock[];
  aborted?: boolean;
  timestamp?: number;
  /** Compaction metadata — only present when role === "compaction_boundary" */
  compaction?: {
    trigger: "manual" | "auto";
    pre_tokens: number;
  };
}

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface Attachment {
  type: "image" | "file";
  mediaType: string;
  data: string; // base64
  filename?: string;
}

// Gateway protocol types
export interface GatewayMessage {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  event?: string;
}

// Editor context (for VS Code integration)
export interface EditorContext {
  filePath: string;
  fileName: string;
  languageId: string;
  relativePath?: string;
  currentLine: number;
  selection?: string;
  selectionRange?: {
    startLine: number;
    endLine: number;
  };
}
