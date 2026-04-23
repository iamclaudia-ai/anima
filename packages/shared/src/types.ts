import type { ZodType } from "zod/v4";
import type { LoggerFactoryOptions, LoggerLike } from "./logger";

/**
 * Core types for Claudia
 */

export interface SessionState {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;
  status: "idle" | "thinking" | "streaming" | "error";
}

// ============================================================================
// Workspace & Session Management
// ============================================================================

export interface Workspace {
  id: string; // TypeID: ws_<ulid>
  name: string;
  cwd: string;
  general: boolean;
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string; // TypeID: ses_<ulid>
  workspaceId: string;
  sessionId: string; // Claude Code UUID (for resume)
  status: "active" | "archived";
  title: string | null;
  summary: string | null;
  previousSessionId: string | null;
  lastActivity: string;
  createdAt: string;
}

export interface Extension {
  id: string;
  name: string;
  methods: string[];
  events: string[];
  status: "starting" | "running" | "stopped" | "error";
}

export interface Client {
  id: string;
  connectedAt: Date;
  subscriptions: Subscription[];
}

export interface Subscription {
  events: string[]; // e.g., ["session.*", "voice.wake"]
  sessionId?: string; // scope to specific session
  extensionId?: string; // scope to specific extension
}

// Stream event types from Claude Code
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface ChunkEvent extends StreamEvent {
  type: "chunk";
  text: string;
}

export interface ThinkingEvent extends StreamEvent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseEvent extends StreamEvent {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends StreamEvent {
  type: "tool_result";
  output: string;
  isError?: boolean;
}

export interface CompleteEvent extends StreamEvent {
  type: "complete";
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ErrorEvent extends StreamEvent {
  type: "error";
  error: string;
}

// ============================================================================
// Extension System
// ============================================================================

/**
 * Gateway event that flows through the event bus
 */
export interface GatewayEvent {
  type: string;
  payload: unknown;
  timestamp: number;
  /** Event origin (e.g., "session", "extension:voice", "gateway") */
  origin?: string;
  /** Message source for routing (e.g., "imessage/+1555...", "web", "gateway.caller") */
  source?: string;
  sessionId?: string;
  /** Identifies the originating WS connection */
  connectionId?: string;
  /** Opaque tags for extension-specific opt-in capabilities (e.g., "voice.speak") */
  tags?: string[];
}

/**
 * Source routing - maps source prefixes to handlers
 * e.g., "imessage" -> iMessage extension handles all "imessage/*" sources
 */
export interface SourceRoute {
  /** Source prefix this route handles (e.g., "imessage", "slack") */
  prefix: string;
  /** Extension ID that handles this source */
  extensionId: string;
  /** Callback to route responses back to this source */
  handler: (event: GatewayEvent) => Promise<void>;
}

/**
 * Context passed to extensions on start
 */
export interface ExtensionContext {
  /** Subscribe to gateway events */
  on(pattern: string, handler: (event: GatewayEvent) => void | Promise<void>): () => void;
  /** Emit an event to the gateway */
  emit(
    type: string,
    payload: unknown,
    options?: {
      source?: string;
      /** Override auto-stamped connectionId (e.g., for connection-scoped routing) */
      connectionId?: string;
      /** Override auto-stamped tags */
      tags?: string[];
    },
  ): void;
  /** Call another extension's method through the gateway hub */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** The originating WebSocket connection ID (set per-request by gateway envelope) */
  connectionId: string | null;
  /** Opaque tags from the request/event envelope (set per-request by gateway envelope) */
  tags: string[] | null;
  /** Extension configuration */
  config: Record<string, unknown>;
  /** Logger — writes to console + file at ~/.anima/logs/{extensionId}.log */
  log: LoggerLike;
  /** Create scoped or dedicated loggers using the shared logging backend */
  createLogger(options?: LoggerFactoryOptions): LoggerLike;
  /** Persistent key-value store at ~/.anima/<extensionId>/store.json.
   *  Supports dot notation for nested access. Persists on every set/delete. */
  store: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): boolean;
    all(): Record<string, unknown>;
  };
}

/**
 * Extension interface - all extensions must implement this
 */
export interface AnimaExtension {
  /** Extension method definitions (inputSchema required for validation + discovery) */
  methods: ExtensionMethodDefinition[];
  /** Unique extension ID (e.g., "voice", "memory") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Events this extension emits (e.g., ["voice.speaking", "voice.done"]) */
  events: string[];
  /** Source prefixes this extension handles for routing (e.g., ["imessage", "slack"]) */
  sourceRoutes?: string[];

  /** Called when the extension is loaded */
  start(ctx: ExtensionContext): Promise<void>;
  /** Called when the extension is unloaded */
  stop(): Promise<void>;
  /** Handle a method call from a client */
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Handle a response that needs to be routed back to a source this extension owns */
  handleSourceResponse?(source: string, event: GatewayEvent): Promise<void>;
  /** Health check */
  health(): { ok: boolean; details?: Record<string, unknown> };
}

export interface ExtensionMethodDefinition {
  /** Fully-qualified method name (e.g., "voice.speak") */
  name: string;
  /** Short human-readable description for CLI/help output */
  description: string;
  /** Required request schema used by gateway as a pre-dispatch bouncer */
  inputSchema: ZodType;
  /** Optional output schema (future use) */
  outputSchema?: ZodType;
  /** Optional execution policy used by the extension host runtime scheduler */
  execution?: ExtensionMethodExecution;
}

export type ExtensionMethodLane = "control" | "read" | "write" | "long_running" | "stream";
export type ExtensionMethodConcurrency = "parallel" | "serial" | "keyed";

export interface ExtensionMethodExecution {
  /** Scheduling lane for the host runtime */
  lane?: ExtensionMethodLane;
  /** Concurrency policy within the lane */
  concurrency?: ExtensionMethodConcurrency;
  /** Params key to serialize by when concurrency = keyed */
  keyParam?: string;
  /** Envelope context field to serialize by when concurrency = keyed */
  keyContext?: "connectionId";
}

// ============================================================================
// Health Check Contract (for Mission Control)
// ============================================================================

/**
 * Standardized health check response returned by extensions that
 * implement a `{id}.health-check` method. Mission Control discovers
 * these extensions and renders their status generically.
 */
export interface HealthCheckResponse {
  ok: boolean;
  /** Overall status: "healthy", "degraded", "error", "disconnected" */
  status: string;
  /** Display name: "Chat Sessions", "Voice (ElevenLabs)" */
  label: string;
  /** Key stats to display */
  metrics?: HealthMetric[];
  /** Callable actions (kill, restart, etc.) */
  actions?: HealthAction[];
  /** Managed resources (sessions, connections, etc.) */
  items?: HealthItem[];
}

export interface HealthMetric {
  label: string;
  value: string | number;
}

export interface HealthAction {
  /** WebSocket method to call: "session.close_session" */
  method: string;
  /** Button label: "Kill Session" */
  label: string;
  /** Confirmation prompt (shows dialog if set) */
  confirm?: string;
  /** Parameters the UI needs to resolve and pass */
  params: ActionParam[];
  /** "item" = per-row button, "global" = card-level button */
  scope?: "item" | "global";
}

export interface ActionParam {
  /** Parameter name: "sessionId" */
  name: string;
  /** Where to get the value: "item.id" auto-fills from row, "input" prompts user */
  source: "item.id" | "input";
}

export interface HealthItem {
  /** Resource identifier (e.g., session ID) */
  id: string;
  /** Display label: "~/Projects/claudia" */
  label: string;
  /** Status for colored indicator */
  status: "healthy" | "stale" | "dead" | "inactive";
  /** Extra columns: { model: "claude-opus-4-6", lastActivity: "2m ago" } */
  details?: Record<string, string>;
}

// ============================================================================
// Panel Layout System
// ============================================================================

/**
 * A panel component that an extension contributes to the layout system.
 * Panels are registered by string ID and resolved at runtime — no cross-extension imports.
 *
 * Convention: IDs are namespaced as "{extensionId}.{panelName}" (e.g., "chat.main", "editor.viewer").
 */
export interface PanelDefinition {
  /** Unique panel ID, namespaced by extension (e.g., "chat.main", "editor.viewer") */
  id: string;
  /** Display title for the panel tab */
  title: string;
  /** Icon name (Lucide icon name or emoji) */
  icon?: string;
}

/**
 * A node in the layout tree — either a leaf panel or a split container.
 */
export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface LayoutLeaf {
  /** Panel ID to render (resolved from panel registry at runtime) */
  panel: string;
  /** Size as percentage of parent */
  size?: number;
}

export interface LayoutSplit {
  /** Split direction */
  direction: "horizontal" | "vertical";
  /** Child nodes */
  children: LayoutNode[];
  /** Size as percentage of parent */
  size?: number;
}

/**
 * A named layout configuration with responsive variants.
 * Extensions export these as defaults; user customizations override via persisted JSON.
 */
export interface LayoutDefinition {
  /** Default layout tree */
  default: LayoutNode;
  /** Mobile layout override (matched via media query) */
  mobile?: LayoutNode;
}

// ============================================================================
// Hooks System
// ============================================================================

/**
 * A hook is a lightweight event handler that reacts to gateway lifecycle events.
 * Hooks are loaded by the hooks extension from ~/.anima/hooks and from <workspace>/.anima/hooks.
 */
export interface HookDefinition {
  /** Events to subscribe to (e.g., "turn_stop", "session.created") */
  event: string | string[];
  /** Human-readable description */
  description?: string;
  /** Handler called when a matching event fires */
  handler(ctx: HookContext, payload?: unknown): Promise<void> | void;
}

/**
 * Context passed to hook handlers
 */
export interface HookContext {
  /** Emit an event to the gateway (namespaced as hook.{hookId}.{event}) */
  emit(event: string, payload: unknown): void;
  /** Current workspace info (if available) */
  workspace: { cwd: string } | null;
  /** Current session ID (if available) */
  sessionId: string | null;
  /** Logger */
  log: LoggerLike;
}
