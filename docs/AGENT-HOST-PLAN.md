# Agent Host: Implementation Plan

## 1. Architecture Overview

### The Problem

Today, SDK agent processes (Claude `query()` and Codex `Thread.runStreamed()`) live inside extension host processes. The lifecycle chain is:

```
Watchdog → Gateway (bun --watch) → ExtensionHostProcess (bun --hot) → SDK process
```

When the gateway restarts (HMR, crash, `bun --watch` reload), it kills all `ExtensionHostProcess` children. When an extension host restarts (HMR via `bun --hot`, or auto-restart after crash), the SDK `query()` iterator and `MessageChannel` are destroyed. The user's conversation is severed mid-stream.

### The Solution

Insert a new **agent-host** service between the extensions and the SDK processes. The agent-host is a standalone Bun server managed directly by the watchdog (like the gateway), providing process-level isolation:

```
Watchdog
  ├── Gateway (port 30086, bun --watch)
  │     ├── ExtensionHostProcess: session  ─── WebSocket ───┐
  │     ├── ExtensionHostProcess: codex    ─── WebSocket ───┤
  │     └── ExtensionHostProcess: ...                       │
  └── Agent Host (port 30087, bun run)  ◄──────────────────┘
        ├── SDKSession (query() instance) ── claude-agent-sdk
        ├── SDKSession (query() instance) ── claude-agent-sdk
        └── CodexTask  (Thread)           ── codex-sdk
```

Key properties:

- Agent-host has **no dependency on the gateway** — it runs as a sibling process
- Extensions connect to it via WebSocket, not stdio
- If the gateway or extension host restarts, the WebSocket drops but the SDK process keeps running
- Extensions reconnect and receive buffered events they missed

### Design Principles

1. **Agent-host owns SDK process lifecycle** — `query()`, `MessageChannel`, `AbortController`, `Codex.startThread()` all live here
2. **Extensions become thin RPC clients** — they translate gateway method calls into WebSocket messages to agent-host
3. **Event buffering for reconnection** — agent-host keeps a ring buffer of recent events per session so reconnecting clients can catch up
4. **Session state is durable** — agent-host persists session metadata to disk so it can survive its own restarts (SDK `resume:` handles the actual conversation state)

## 2. Agent Host Server

### Package Location

```
packages/agent-host/
  src/
    index.ts          -- Entry point, HTTP + WebSocket server
    session-host.ts   -- Manages SDKSession instances (extracted from session extension)
    codex-host.ts     -- Manages Codex tasks (extracted from codex extension)
    event-buffer.ts   -- Per-session ring buffer for reconnection replay
    protocol.ts       -- WebSocket message type definitions
    state.ts          -- Persisted state (session registry on disk)
  package.json
  tsconfig.json
```

### Server Architecture

The agent-host runs a single Bun HTTP + WebSocket server on port **30087**. It exposes:

- `GET /health` — health check for watchdog monitoring
- `WS /ws` — WebSocket endpoint for extension clients

The server does NOT use NDJSON stdio — it is a standalone process with its own port, like the gateway.

### WebSocket Protocol

Messages are JSON-encoded, following the same `{ type, ... }` envelope pattern used in the gateway and extension-host NDJSON protocol.

#### Client-to-Server Messages

```typescript
// protocol.ts

/** Identify which extension is connecting and which sessions it wants */
interface AuthMessage {
  type: "auth";
  extensionId: string; // "session" or "codex"
  /** Sessions to subscribe to (reconnect scenario) */
  resumeSessions?: string[];
}

/** Create a new SDK session */
interface CreateSessionMessage {
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
interface PromptMessage {
  type: "session.prompt";
  requestId: string;
  sessionId: string;
  content: string | unknown[];
  cwd?: string; // for auto-resume
}

/** Interrupt a session */
interface InterruptMessage {
  type: "session.interrupt";
  requestId: string;
  sessionId: string;
}

/** Close a session */
interface CloseMessage {
  type: "session.close";
  requestId: string;
  sessionId: string;
}

/** Set permission mode */
interface SetPermissionModeMessage {
  type: "session.set_permission_mode";
  requestId: string;
  sessionId: string;
  mode: string;
}

/** Send tool result */
interface SendToolResultMessage {
  type: "session.send_tool_result";
  requestId: string;
  sessionId: string;
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** List active sessions */
interface ListSessionsMessage {
  type: "session.list";
  requestId: string;
}

/** Codex: start a task */
interface CodexStartMessage {
  type: "codex.start";
  requestId: string;
  taskType: "task" | "review" | "test";
  prompt: string;
  sessionId: string; // for completion notification
  cwd?: string;
  sandbox?: string;
  model?: string;
  effort?: string;
}

/** Codex: interrupt active task */
interface CodexInterruptMessage {
  type: "codex.interrupt";
  requestId: string;
}

/** Codex: status check */
interface CodexStatusMessage {
  type: "codex.status";
  requestId: string;
}
```

#### Server-to-Client Messages

```typescript
/** Response to a request (success or error) */
interface ResponseMessage {
  type: "res";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** Streaming event from an SDK session */
interface SessionEventMessage {
  type: "session.event";
  sessionId: string;
  event: {
    type: string; // "message_start", "content_block_delta", "turn_stop", etc.
    [key: string]: unknown;
  };
  /** Monotonic sequence number within the session, for gap detection on reconnect */
  seq: number;
}

/** Streaming event from a Codex task */
interface CodexEventMessage {
  type: "codex.event";
  taskId: string;
  event: {
    type: string; // "turn_start", "message_delta", "turn_stop", etc.
    [key: string]: unknown;
  };
  seq: number;
}
```

### Event Buffering (event-buffer.ts)

Each session/task maintains a ring buffer of the last N events (default: 500). Events are assigned a monotonic sequence number. When a client reconnects and sends `resumeSessions`, the server replays events from the client's last-seen sequence number.

```typescript
class EventBuffer {
  private buffer: Array<{ seq: number; event: unknown }> = [];
  private nextSeq = 1;
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(event: unknown): number {
    const seq = this.nextSeq++;
    this.buffer.push({ seq, event });
    if (this.buffer.length > this.maxSize) this.buffer.shift();
    return seq;
  }

  /** Get events after a given sequence number */
  getAfter(lastSeenSeq: number): Array<{ seq: number; event: unknown }> {
    return this.buffer.filter((e) => e.seq > lastSeenSeq);
  }

  get currentSeq(): number {
    return this.nextSeq - 1;
  }
}
```

## 3. Session Extension Changes

The session extension (`extensions/session/src/index.ts`) becomes a **thin client** that:

1. Maintains a WebSocket connection to the agent-host
2. Translates `session.*` method calls into WebSocket messages
3. Receives `session.event` messages from the WebSocket and emits them via `ctx.emit()` (preserving the existing `requestContexts` / `primaryContexts` routing logic)
4. Reconnects automatically if the WebSocket drops

### What stays in the session extension

- All workspace management (`listWorkspaces`, `getWorkspace`, `getOrCreateWorkspace`) — DB operations, not SDK-dependent
- Session discovery (`discoverSessions`, `readSessionsIndexMap`) — disk reads only
- Session history parsing (`parseSessionFile`, `parseSessionFilePaginated`) — disk reads only
- Request context tracking (`requestContexts`, `primaryContexts`, `mergeTags`) — gateway-side routing logic
- The `session.health_check` method — augmented to include agent-host connectivity status

### What moves to agent-host

- `SDKSession` class (the entire file `sdk-session.ts`)
- `SessionManager` class (create, resume, prompt, interrupt, close, list, sendToolResult, setPermissionMode)
- The `session.send_notification` wrapping logic (`<user_notification>` tags → `manager.prompt`)

### New session extension structure

```typescript
// extensions/session/src/agent-client.ts

class AgentHostClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: Timer | null = null;
  private pendingRequests = new Map<string, { resolve, reject, timer }>();
  private lastSeenSeq = new Map<string, number>(); // sessionId -> last seq

  constructor(private url: string) { super(); }

  async connect(): Promise<void> { /* WebSocket connect + auth message */ }

  // RPC methods that send WebSocket messages and await responses
  async createSession(params): Promise<{ sessionId: string }> { ... }
  async prompt(sessionId, content, cwd?): Promise<void> { ... }
  async interrupt(sessionId): Promise<boolean> { ... }
  async close(sessionId): Promise<void> { ... }
  async list(): Promise<SessionInfo[]> { ... }
  async setPermissionMode(sessionId, mode): Promise<void> { ... }
  async sendToolResult(sessionId, toolUseId, content, isError?): Promise<void> { ... }

  // Event handling — emits "session.event" just like the old SessionManager
  private handleSessionEvent(msg: SessionEventMessage): void {
    this.lastSeenSeq.set(msg.sessionId, msg.seq);
    this.emit("session.event", {
      eventName: `session.${msg.sessionId}.${msg.event.type}`,
      sessionId: msg.sessionId,
      ...msg.event,
    });
  }

  // Reconnection with gap replay
  private reconnect(): void {
    const sessions = Array.from(this.lastSeenSeq.keys());
    // On reconnect, send auth with resumeSessions
    // Server replays missed events
  }
}
```

## 4. Codex Extension Changes

Same pattern as session. The codex extension becomes a thin client:

- `Codex` SDK initialization, `Thread` creation, `runStreamedTask`, and `bridgeEvent` all move to agent-host
- The extension keeps: method definitions, Zod schemas, `notifySession` (which uses `ctx.call("session.send_notification")` through the gateway hub)
- A new `CodexAgentClient` class connects to agent-host via the same WebSocket

### Notification optimization

Agent-host can handle notifications internally since it owns both session and codex processes. When a codex task completes, agent-host directly calls `sessionManager.prompt(sessionId, wrappedText)`, eliminating the gateway dependency for notifications. The extension only needs to know the task completed (for UI updates), which comes via the codex event stream.

## 5. Watchdog Integration

### New Service Definition

```typescript
// packages/watchdog/src/services.ts
"agent-host": {
  name: "Agent Host",
  id: "agent-host",
  command: ["bun", "run", "packages/agent-host/src/index.ts"],
  healthUrl: "http://localhost:30087/health",
  port: 30087,
  restartBackoff: 1000,
  // ...
}
```

**Important**: Agent-host uses `bun run` (NOT `bun --watch` and NOT `bun --hot`). It must be maximally stable. Code changes require manual restart via `claudia watchdog restart agent-host`.

### Startup Order

Agent-host starts **before** the gateway since extensions need to connect to it during startup.

## 6. Reconnection Protocol

### Extension Reconnects After Restart

```
Extension Host restarts (HMR or crash)
  → Session extension starts, creates AgentHostClient
  → Connects to ws://localhost:30087/ws
  → Sends: { type: "auth", extensionId: "session", resumeSessions: ["uuid1"] }
  → Agent-host replays buffered events since client's lastSeenSeq
  → Extension is caught up, receives new events in real-time
```

### Agent-Host Restarts

Agent-host persists session registry to `~/.claudia/agent-host/sessions.json`. On restart:

- Reads persisted sessions
- SDK `query()` processes are dead (they were children of the old process)
- On first prompt, uses `resume: sessionId` to recreate the query
- SDK resumes from its JSONL conversation history

This is exactly the "lazy resume" pattern already in `SessionManager.prompt()`.

## 7. Event Flow

### Current Flow

```
UI → Gateway → ExtensionHost (NDJSON) → SessionManager → SDKSession → query()
                                                                         ↓
UI ← Gateway ← ExtensionHost (NDJSON) ← ctx.emit() ← manager.on("session.event")
```

### New Flow

```
UI → Gateway → ExtensionHost (NDJSON) → AgentHostClient → WebSocket → Agent Host
                                                                         ↓
                                                           SessionManager → SDKSession → query()
                                                                         ↓
UI ← Gateway ← ExtensionHost (NDJSON) ← ctx.emit() ← AgentHostClient ← WebSocket
```

The extra WebSocket hop adds negligible latency (localhost). The critical benefit: if the left side restarts (gateway/extension), the right side (agent-host/SDK) keeps running.

## 8. Migration Path

### Phase 1: Agent-host package with SDK session management

- Create `packages/agent-host/` with HTTP + WebSocket server
- Move `SDKSession` and `SessionManager` into it
- Add event buffering, health endpoint, session registry persistence
- **Test**: Manual WebSocket connection, create session, send prompt, verify streaming

### Phase 2: AgentHostClient in session extension

- Create `extensions/session/src/agent-client.ts`
- Add config flag: `"agentHost": { "enabled": true, "url": "ws://localhost:30087/ws" }`
- Dual-mode: direct (current) or proxied (via agent-host)
- **Test**: Enable agent-host mode, verify full round-trip

### Phase 3: Watchdog integration

- Add agent-host to watchdog services
- Ensure startup order: agent-host before gateway
- **Test**: Watchdog manages both services, auto-restart works

### Phase 4: Reconnection

- Implement `resumeSessions` in auth handshake
- Event replay from buffer
- Auto-reconnect with exponential backoff
- **Test**: Start session, restart gateway, verify session survives

### Phase 5: Migrate Codex

- Create `codex-host.ts` in agent-host
- Create `CodexAgentClient` in codex extension
- Same feature-flag approach
- **Test**: Start codex task, restart extension, verify task continues

### Phase 6: Remove direct mode

- Remove `SessionManager` direct import from session extension
- Remove inline SDK management from codex extension
- Agent-host is the single owner of all SDK processes

## 9. File/Package Structure

### New files

```
packages/agent-host/
  package.json                    -- @claudia/agent-host
  tsconfig.json
  src/
    index.ts                      -- HTTP + WebSocket server (port 30087)
    protocol.ts                   -- TypeScript interfaces for WS messages
    session-host.ts               -- SDKSession + SessionManager
    codex-host.ts                 -- Codex task management
    event-buffer.ts               -- Per-session ring buffer
    state.ts                      -- Persisted session/task registry

extensions/session/src/
  agent-client.ts                 -- NEW: WebSocket client for agent-host

extensions/codex/src/
  codex-client.ts                 -- NEW: WebSocket client for agent-host
```

### Modified files

```
extensions/session/src/index.ts   -- Add AgentHostClient, feature flag
extensions/codex/src/index.ts     -- Add CodexAgentClient, feature flag
packages/watchdog/src/services.ts -- Add agent-host service
packages/shared/src/config.ts     -- Add agentHost config section
claudia.example.json              -- Add agentHost section
```

## 10. Edge Cases

### Gateway restarts during active streaming

Agent-host WebSocket sees client disconnect. SDK session keeps running, events buffer. Extension reconnects, replays missed events, streaming resumes.

### Agent-host restarts

All `query()` processes die. Session registry persists. Extensions reconnect, lazy-resume recreates SDK sessions on next prompt. In-flight streaming is lost but conversation state survives in JSONL.

### Extension sends prompt while agent-host is down

`AgentHostClient` queues the prompt, attempts reconnection with backoff, replays queued prompt once reconnected. Or returns error for UI to display.

### Multiple extensions subscribe to same session

Each WebSocket client tracks its own `lastSeenSeq`. Agent-host broadcasts to all subscribed clients.

### Codex notification routing (optimization)

Agent-host handles notifications internally since it owns both session and codex. Eliminates gateway dependency for cross-agent communication.

### Config propagation

Agent-host reads `~/.claudia/claudia.json` directly via `loadConfig()` from `@claudia/shared`, same as the gateway. No need for config to flow through extensions.
