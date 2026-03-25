# Anima Architecture

## System Overview

Anima is a three-tier system:

1. **Watchdog** (port 30085) — Process supervisor
2. **Agent Host** (port 30087) — SDK process isolation
3. **Gateway** (port 30086) — Event bus + extension host

The watchdog manages gateway and agent-host as direct child processes. The agent-host owns all SDK processes (Claude `query()`, Codex `Thread`) and survives gateway/extension restarts. The gateway is a pure event bus that validates, routes, and fans out messages but owns no domain logic. Extensions run as separate processes communicating over NDJSON stdio.

```
┌────────────────────────────────────────────────────────────────────┐
│                         Clients                                    │
│  Web UI · CLI · VS Code · macOS Menubar · iOS · iMessage           │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ WebSocket (req/res/event protocol)
┌──────────────────────────▼─────────────────────────────────────────┐
│                      Watchdog (port 30085)                          │
│                                                                    │
│  ┌─────────────────────────┐  ┌──────────────────────────────────┐ │
│  │   Agent Host (30087)    │  │      Gateway (30086)             │ │
│  │                         │  │                                  │ │
│  │  SDK Sessions:          │  │  Bun.serve:                      │ │
│  │  ├─ Claude query()      │  │    /ws      → WebSocket          │ │
│  │  └─ Codex Thread        │  │    /health  → Status             │ │
│  │                         │  │    /*       → SPA                │ │
│  │  Event Buffers          │  │                                  │ │
│  │  (ring, seq numbers)    │  │  ┌──────────┐  ┌──────────────┐  │ │
│  │                         │  │  │Event Bus │  │  Extension   │  │ │
│  │  WebSocket Server       │  │  │(WS pub/  │  │  Manager     │  │ │
│  └─────────▲───────────────┘  │  │ sub)     │  │  (routing)   │  │ │
│            │                  │  └──────────┘  └──────────────┘  │ │
│            │ WebSocket (RPC)  └────┬───────────┬───────────┬─────┘ │
│            └───────────────────────┘           │           │       │
└────────────────────────────────────────────────┼───────────┼───────┘
                                        NDJSON stdio        │
                                    ┌───▼────┐  ┌───▼────┐  ┌──▼────┐
                                    │session │  │ voice  │  │  ...  │
                                    │        │  │        │  │       │
                                    │WS proxy│  │Cartesia│  │hooks, │
                                    │to agent│  │TTS,    │  │imsg,  │
                                    │host    │  │stream  │  │memory │
                                    └────────┘  └────────┘  └───────┘
```

## Gateway (port 30086)

The gateway is a pure message hub. Single Bun.serve instance handling HTTP, WebSocket, and static file serving.

### Request Handling

```
fetch(req):
  /ws      → WebSocket upgrade → handleMessage()
  /health  → JSON status (extensions, connections)
  /*       → SPA fallback (index.html, Tailwind + Bun bundling)

websocket:
  open     → register client, assign ID
  message  → parse JSON → validate schema → route to extension
  close    → cleanup client
```

### Gateway-Owned Methods

The gateway itself only owns discovery and subscription methods:

| Method                      | Purpose                         |
| --------------------------- | ------------------------------- |
| `gateway.list_methods`      | All methods with schemas        |
| `gateway.list_extensions`   | All loaded extensions           |
| `gateway.subscribe`         | Subscribe to event patterns     |
| `gateway.unsubscribe`       | Remove subscriptions            |
| `gateway.restart_extension` | Restart a single extension host |

Everything else is handled by extensions.

### Method Routing

All methods are namespaced by extension ID. The gateway routes by prefix to the owning extension:

```
session.send_prompt    → session extension
voice.speak            → voice extension
chat.health_check      → chat extension
gateway.list_methods   → gateway itself
```

### Event Fanout

Events flow through two channels:

- **WebSocket clients** — subscription-based. Clients subscribe to event patterns with wildcards (e.g., `session.*`, `*`). Events broadcast only to matching subscribers.
- **Extensions** — pattern-based. Extensions declare event patterns at registration time and receive matching events over their NDJSON stdio channel.

### Key Files

| File                    | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `src/index.ts`          | Bun.serve, WS handlers, event routing                 |
| `src/extensions.ts`     | ExtensionManager, method/event routing, ctx.call()    |
| `src/extension-host.ts` | ExtensionHostProcess, spawns extensions, NDJSON stdio |
| `src/start.ts`          | Config-driven extension loading                       |
| `src/db/`               | SQLite (migrations only, data owned by extensions)    |
| `src/web/`              | SPA shell (index.html + route collector)              |

## Agent Host (port 30087)

The agent-host is a dedicated runtime server that owns all SDK processes and long-lived agent state. It runs as a sibling service to the gateway (both supervised by watchdog) and communicates with extensions via WebSocket.

### Purpose

Process isolation — SDK sessions and tasks survive gateway/extension restarts. If the gateway restarts (code changes, crashes), Claude sessions and Codex tasks keep running uninterrupted in agent-host.

### Architecture

```
Agent Host (port 30087)
├── SessionHost — manages Claude SDK sessions
│   ├── SDK runtime (query() from @anthropic-ai/claude-agent-sdk)
│   ├── Event buffers with sequence numbers (replay on reconnect)
│   ├── Session registry (persisted to ~/.anima/agent-host-state.json)
│   └── Idle session reaper (closes stale sessions to reclaim resources)
├── TaskHost — manages delegated tasks (codex, future gemini)
│   ├── Codex SDK runtime (@openai/codex-sdk)
│   ├── Task registry with status tracking
│   ├── Event buffers with sequence numbers
│   └── Per-agent drivers (CodexDriver, future GeminiDriver)
└── WebSocket Server — RPC protocol for extensions
    ├── /ws → session/task operations
    └── /health → status + active sessions/tasks
```

### Key Features

- **Multi-provider routing**: `agent` parameter determines which driver handles the request
- **Event replay**: Sequence numbers enable gap-free reconnection after network drops
- **Crash recovery**: Persisted session registry auto-resumes on startup
- **Resource management**: Idle reaper closes stale SDK processes after 10min inactivity
- **Unified protocol**: `@anima/shared/agent-host-protocol` — shared types between host and extensions

### Key Files

| File                  | Purpose                                       |
| --------------------- | --------------------------------------------- |
| `src/index.ts`        | Server entrypoint, idle reaper, lock clearing |
| `src/server.ts`       | WebSocket server, message routing             |
| `src/session-host.ts` | Claude SDK session management                 |
| `src/task-host.ts`    | Task runtime (codex driver)                   |
| `src/event-buffer.ts` | Ring buffer with sequence numbers for replay  |

## WebSocket Protocol

All client communication uses a single protocol:

```
Client ──req──► Gateway ──res──► Client     (request/response)
                Gateway ──event─► Client     (push events)
```

### Message Types

```typescript
// Request: client → gateway
{ type: "req", id: string, method: string, params?: Record<string, unknown> }

// Response: gateway → client
{ type: "res", id: string, ok: boolean, payload?: unknown, error?: string }

// Event: gateway → client (streaming, notifications)
{ type: "event", event: string, payload: unknown }
```

### Schema Validation

All methods declare Zod schemas for input validation. The gateway validates params at the boundary before dispatching to extensions. Invalid requests receive clear error messages.

### Event Subscriptions

```typescript
// Subscribe to all session events
{ method: "gateway.subscribe", params: { events: ["session.*"] } }

// Subscribe to everything
{ method: "gateway.subscribe", params: { events: ["*"] } }
```

## Extension System

### Architecture

Extensions are out-of-process. The gateway spawns one child process per enabled extension:

```
bun --hot extensions/<id>/src/index.ts <config-json>
```

Each extension's `index.ts` is directly executable:

```typescript
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createMyExtension);
```

Native HMR via `bun --hot` — code changes reload extensions without restarting the gateway or dropping WebSocket connections. Extensions can opt out of HMR with `hot: false` in config (useful for extensions managing long-lived processes like Claude Code sessions). Non-hot extensions can be manually restarted via `gateway.restart_extension`.

Communication between gateway and extension processes uses NDJSON over stdio (stdin/stdout pipes).

### Extension Loading

Extensions are config-driven from `~/.anima/anima.json`. The gateway resolves `extensions/<id>/src/index.ts` and starts one `ExtensionHostProcess` per enabled extension.

### Extension Process Singleton + Generations

The gateway now enforces a singleton host process per extension ID across gateway instances using DB-backed locks (`extension_process_locks`).

- Before spawn, `start.ts` acquires the extension lock.
- If another gateway instance holds a fresh lock, spawn is skipped.
- Stale locks are stolen automatically.
- A heartbeat renews each lock while the host is running.
- If lock renewal fails, the gateway stops that extension host.

Each extension host spawn also gets a generation token. The gateway tracks the current generation for each extension and drops stale events from older generations to prevent duplicate fanout during HMR/restart races.

### Extension Interface

```typescript
interface ExtensionMethodDefinition {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
}

interface AnimaExtension {
  id: string;
  name: string;
  methods: ExtensionMethodDefinition[];
  events: string[];
  sourceRoutes?: string[];
  start(ctx: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  health(): HealthCheckResponse;
}
```

### ExtensionContext

The context provided to each extension at startup:

- `on(pattern, handler)` — subscribe to gateway events (wildcard support)
- `emit(type, payload)` — emit events to the bus
- `call(method, params)` — inter-extension RPC via the gateway hub
- `config` — extension configuration
- `log` — scoped logger
- `createLogger(...)` — shared logger factory for scoped or dedicated trace files
- `store` — persistent JSON-backed key/value state at `~/.anima/<extensionId>/store.json`

Extensions now use a two-phase startup model:

1. register metadata immediately so methods are callable during startup
2. finish cross-extension startup work only after the gateway broadcasts `gateway.extensions_ready`

This is the pattern used by iMessage startup catchup and other features that need `ctx.call()` to peers during initialization.

### ctx.call() Hub

Extensions call each other through the gateway as a hub:

```
Extension A → ctx.call("session.send_prompt", {...})
  → gateway hub
  → Extension B handles method
  → response returns to Extension A
```

RPC metadata: `traceId`, `depth` (max 8), `deadlineMs`. Per-extension rate limit: 50 in-flight calls.

### Extensions

| Extension       | ID         | What It Does                                                                           |
| --------------- | ---------- | -------------------------------------------------------------------------------------- |
| Session         | `session`  | Thin RPC client to agent-host, workspace CRUD, history parsing, provider-aware routing |
| Chat            | `chat`     | Web pages: /, /workspace/:workspaceId/session/:sessionId                               |
| Voice           | `voice`    | Cartesia Sonic 3.0 TTS, streaming audio                                                |
| iMessage        | `imessage` | iMessage bridge, auto-reply                                                            |
| Mission Control | `control`  | System dashboard, health checks                                                        |
| Hooks           | `hooks`    | Lightweight event-driven scripts                                                       |
| Memory          | `memory`   | Transcript ingestion + Libby processing                                                |

### Client-Side Extensions (Routes)

Extensions can declare web pages:

```
extensions/<name>/src/
  index.ts       # Server: createMyExtension() → AnimaExtension
  routes.ts      # Client: export const myRoutes: Route[]
  pages/         # React page components
```

Routes use feature paths (e.g., `/control`); chat owns `/`. The web shell (`packages/gateway/src/web/index.tsx`) imports routes from all extensions and feeds them to the `Router` component.

### Health Checks

Every extension exposes a `{id}.health_check` method returning structured status:

```typescript
interface HealthCheckResponse {
  ok: boolean;
  status: "healthy" | "degraded" | "disconnected" | "error";
  label: string;
  metrics?: Array<{ label: string; value: string | number }>;
  actions?: Array<{ label: string; method: string; params?: Record<string, unknown> }>;
  items?: Array<{ id: string; label: string; status: string }>;
}
```

Gateway `/health` includes extension lock diagnostics (`extensionLocks`) so Mission Control can show lock ownership and stale/contended states.

## Session Extension

The session extension is a thin RPC client to agent-host that manages workspace/session CRUD, history parsing, and provider-aware routing.

### Agent-Host RPC Client

The session extension uses `AgentHostClient` — a WebSocket client that connects to agent-host (port 30087):

- **Auto-reconnect** with exponential backoff (1s → 10s max)
- **Event replay** on reconnection via sequence numbers (gap-free streaming)
- **RPC methods**: `createSession()`, `prompt()`, `interrupt()`, `close()`, `startTask()`, `getTask()`, etc.
- **Event handlers**: `session.event` and `task.event` translate agent-host events to gateway events

All SDK runtime (Claude `query()`, Codex tasks) lives in agent-host — the session extension just routes requests and events.

### Provider-Aware Routing

Session methods accept an optional `agent` parameter for provider routing:

```typescript
// Claude session (default)
await session.send_prompt({ sessionId, content, agent: "claude" });

// Codex task delegation
await session.start_task({ sessionId, agent: "codex", prompt, mode: "review" });
```

Agent-host owns the provider drivers and routes by agent type. Session extension is provider-agnostic.

### Request Context Tracking

The session extension manages request contexts for connectionId and tags:

- **Primary contexts**: Long-lived streaming contexts (e.g., voice tags persist through tool calls)
- **Transient contexts**: Per-request contexts that clear after response
- **Tag merging**: Combines primary + transient tags so capabilities like voice survive CLI notifications

### Workspace Registry

Workspace and session metadata stored in SQLite (WAL mode). Session source-of-truth is the filesystem — session history lives in `~/.claude/projects/{dash-encoded-cwd}/*.jsonl`.

### History Parsing

Session history is parsed from JSONL files on disk with pagination. Uses load-all-then-slice (required because tool results in user messages backfill earlier assistant tool_use blocks):

```
Request:  { method: "session.history", params: { sessionId: "...", limit: 50, offset: 0 } }
Response: { messages: [...50], total: 4077, hasMore: true, offset: 0 }
```

### Session Lifecycle

1. **Create**: client calls `session.create_session` with `cwd`
2. **First prompt**: `session.send_prompt` starts SDK `query()` with `sessionId`
3. **Resume**: auto-resume with `cwd` when session not in memory
4. **History**: parsed from JSONL files on disk
5. **Interrupt**: `query.interrupt()` + synthetic stop events for immediate UI update

### Thinking Effort Levels

| Effort   | Tokens |
| -------- | ------ |
| `low`    | 4,000  |
| `medium` | 8,000  |
| `high`   | 16,000 |
| `max`    | 32,000 |

## Data Flow

### Prompts (User → Claude)

```
Browser → Gateway WS → session extension (NDJSON stdio) → SDK query() → Claude API
```

Attachments are sent as Anthropic API content blocks:

- Images: `{ type: "image", source: { type: "base64", media_type, data } }`
- Files: `{ type: "document", source: { type: "base64", media_type, data } }`

### Streaming (Claude → User)

```
Claude API → Agent SDK → session extension → gateway event bus → WS clients
```

SSE event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `turn_stop`

### Voice

```
session events → voice extension (via event bus) → Cartesia TTS → audio chunks
  → gateway → scoped to originating WS connection
```

### Source Routing

For extensions bridging external systems (e.g., iMessage):

```
iMessage from +1234 → imessage extension → ctx.call("session.send_prompt", ...)
  → Claude responds → message_stop event
  → imessage extension receives event → sends reply to chat
```

## Client-Side Router

Zero-dependency pushState router in `packages/ui/src/router.tsx` (~75 lines):

- `matchPath(pattern, pathname)` — regex `:param` matching
- `Router` component — iterates routes, first match wins
- `navigate(path)` — pushState + dispatch popstate
- `Link` component — respects modifier keys
- `useRouter()` hook — current pathname, params, navigate

The gateway's `"/*"` route serves `index.html` for all paths, enabling clean URLs.

## Watchdog (port 30085)

Standalone process supervisor that manages the gateway as a direct child process via `Bun.spawn`.

```
Watchdog (port 30085)
  ├── Bun.spawn → Gateway (port 30086)  stdout/stderr → ~/.anima/logs/gateway.log
  ├── Health monitor (5s interval, 6 consecutive failures → restart)
  ├── Orphan detection via lsof before restarts
  ├── Web dashboard with log viewer + service status
  └── Diagnose & Fix (spawns Claude to auto-fix errors)
```

### Key Design Decisions

- **Direct child process** — No tmux, no screen. Watchdog owns the full process lifecycle.
- **SIGINT/SIGTERM** kills children — clean shutdown, no orphans.
- **Zero monorepo imports** — watchdog is self-contained so it keeps running even when gateway/shared packages have build errors.
- **Orphan port detection** — Before starting a service, `lsof` checks for processes already bound to the port and kills them.

### HTTP API

| Endpoint              | Method | Description                            |
| --------------------- | ------ | -------------------------------------- |
| `/status`             | GET    | JSON status of all services            |
| `/api/logs`           | GET    | List log files                         |
| `/api/logs/:filename` | GET    | Tail a log file (supports pagination)  |
| `/restart/:id`        | POST   | Restart a service                      |
| `/diagnose`           | POST   | Start autonomous diagnosis with Claude |
| `/*`                  | GET    | Dashboard SPA                          |

## Ports

| Port  | Service  | Description                         |
| ----- | -------- | ----------------------------------- |
| 30085 | Watchdog | Process supervisor + dashboard      |
| 30086 | Gateway  | HTTP + WebSocket + SPA + Extensions |

Port 30086 is the fixed gateway port for Anima.

## File Map

```
packages/
  gateway/              # Pure hub — routes messages, no business logic
    src/
      index.ts            Bun.serve, WS handlers, event routing
      start.ts            Config-driven extension loading
      extensions.ts       ExtensionManager, method/event routing, ctx.call()
      extension-host.ts   ExtensionHostProcess, spawns extensions, NDJSON stdio
      db/                 SQLite (migrations)
      web/                SPA shell (index.html + route collector)

  watchdog/             # Process supervisor for gateway
    src/
      index.ts            Bun.serve on port 30085, health monitor, startup
      services.ts         Bun.spawn child processes, health checks, auto-restart
      dashboard/          Vanilla TypeScript dashboard UI

  extension-host/       # runExtensionHost() — NDJSON stdio bridge (imported by extensions)
    src/
      index.ts            Dynamic import, NDJSON stdio, parent PID watchdog

  cli/                  # Schema-driven CLI with method discovery
    src/
      index.ts            Method discovery, param validation, type coercion

  shared/               # Types, config, protocol, reusable gateway client
    src/
      types.ts            Extension, session, workspace types
      protocol.ts         WebSocket protocol types (req/res/event)
      config.ts           anima.json loader with env var interpolation
      gateway-client.ts   Environment-agnostic Gateway RPC/event client

  ui/                   # React components + router
    src/
      router.tsx          Client-side pushState router
      hooks/              useChatGateway, useGatewayClient, useAudioPlayback
      components/         ClaudiaChat, MessageList, NavigationDrawer

  memory-mcp/           # MCP server for persistent memory system

extensions/
  session/src/          # Session lifecycle, SDK engine, workspace CRUD
  chat/src/             # Web pages: /, /workspace/:workspaceId/session/:sessionId
  voice/src/            # Cartesia Sonic 3.0 TTS, streaming audio
  imessage/src/         # iMessage bridge, auto-reply
  control/src/          # System dashboard, health checks
  hooks/src/            # Event-driven scripts
  memory/src/           # Transcript ingestion + Libby processing

clients/
  ios/                  # Native Swift voice mode app
  menubar/              # macOS menubar app (SwiftUI)
  vscode/               # VS Code extension with sidebar chat

scripts/
  smoke.ts              # Quick smoke test (health + gateway.list_methods)
  e2e-smoke.ts          # Full E2E test with model call

skills/                 # Claude Code skills (meditation, stories, TTS tools)
```
