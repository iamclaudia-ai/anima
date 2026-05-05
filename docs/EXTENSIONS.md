# Extension Guide

How to build, configure, and run Anima extensions.

## Overview

Extensions are the primary way to add features to Anima. Every capability — web chat, voice, iMessage, Mission Control — is an extension. Extensions register schema-driven methods, subscribe to the event bus, and optionally serve web pages.

Extensions are **directly executable** — each extension is its own entry point that the gateway spawns as a child process. This means native HMR via `bun --hot`, no indirection, and zero-downtime code reloads without dropping WebSocket connections.

Server entrypoint convention is strict: every extension must expose `extensions/<id>/src/index.ts`. Do not use alternate server entrypoint filenames.

## Quick Start

### 1. Create the extension package

```
extensions/my-feature/
├── package.json
└── src/
    └── index.ts
```

```json
{
  "name": "@anima/ext-my-feature",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@anima/extension-host": "workspace:*",
    "@anima/shared": "workspace:*",
    "zod": "^3.25.76"
  }
}
```

The `@anima/extension-host` dependency provides `runExtensionHost()` — the function that wires your extension into the NDJSON stdio protocol. Every extension needs it.

### 2. Implement the extension

```typescript
import { z } from "zod";
import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";

export function createMyFeatureExtension(config: MyFeatureConfig = {}): AnimaExtension {
  let ctx: ExtensionContext;

  return {
    id: "my-feature",
    name: "My Feature",
    methods: [
      {
        name: "my-feature.do_thing",
        description: "Does the thing",
        inputSchema: z.object({
          input: z.string().min(1),
        }),
      },
      {
        name: "my-feature.health_check",
        description: "Health status for Mission Control",
        inputSchema: z.object({}),
      },
    ],
    events: ["my-feature.thing_done"],

    async start(context) {
      ctx = context;
      ctx.log.info("My Feature started");

      // Subscribe to gateway events
      ctx.on("session.message_stop", async (event) => {
        // React to session completion
      });
    },

    async stop() {
      // Cleanup resources
    },

    async handleMethod(method, params) {
      switch (method) {
        case "my-feature.do_thing": {
          const result = doTheThing(params.input as string);
          ctx.emit("my-feature.thing_done", { result });
          return { status: "ok", result };
        }
        case "my-feature.health_check": {
          const response: HealthCheckResponse = {
            ok: true,
            status: "healthy",
            label: "My Feature",
            metrics: [{ label: "Status", value: "running" }],
          };
          return response;
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return { ok: true };
    },
  };
}

export default createMyFeatureExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createMyFeatureExtension);
```

The last two lines are critical. `runExtensionHost()` handles the entire stdio protocol — console redirection, NDJSON I/O, event bus, `ctx.call()`, parent liveness detection, and HMR lifecycle. The `import.meta.main` guard ensures it only runs when the file is executed directly (not when imported for testing).

### 3. Configure in anima.json

```json5
// ~/.anima/anima.json
{
  extensions: {
    "my-feature": {
      enabled: true,
      // hot: true,  // default — bun --hot for live reload on code changes
      // hot: false,  // use bun run instead — for extensions managing long-lived processes
      config: {
        // Extension-specific config
      },
    },
  },
}
```

Your extension ID in config must match the folder name under `extensions/`.

The `hot` flag controls whether the extension runs with `bun --hot` (live HMR on code changes) or `bun run` (requires manual restart). Default is `true`. Set `hot: false` for extensions that manage long-lived child processes (like the session extension managing Claude Code sessions) where an HMR reload would be disruptive. Non-hot extensions can be restarted individually via `gateway.restart_extension`.

### 4. Verify

```bash
# Check it loaded
bun run packages/cli/src/index.ts gateway.list_methods | grep my-feature

# Call a method
bun run packages/cli/src/index.ts my-feature.do_thing --input "hello"

# Health check
bun run packages/cli/src/index.ts my-feature.health_check
```

---

## Extension Interface

All extensions implement `AnimaExtension` from `@anima/shared`:

```typescript
interface AnimaExtension {
  id: string; // Unique ID: "voice", "imessage"
  name: string; // Display name: "Voice (TTS)"
  methods: ExtensionMethodDefinition[];
  events: string[]; // Events this extension emits
  sourceRoutes?: string[]; // Source prefixes for routing (e.g., ["imessage"])

  start(ctx: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  handleMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  handleSourceResponse?(source: string, event: GatewayEvent): Promise<void>;
  health(): { ok: boolean; details?: Record<string, unknown> };
}
```

### Factory Function

Extensions export a factory function named `createXxxExtension` and wire it into `runExtensionHost()`:

```typescript
export function createVoiceExtension(config: VoiceConfig = {}): AnimaExtension { ... }
export default createVoiceExtension;

// Direct execution — gateway spawns this file directly
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createVoiceExtension);
```

The factory is passed directly to `runExtensionHost()` — no dynamic import, no discovery, no reflection. Always provide both named and default exports (named for testing imports, default as convention).

### ExtensionContext

The context object passed to `start()` is the extension's bridge to the gateway:

```typescript
interface ExtensionContext {
  /** Subscribe to gateway events */
  on(pattern: string, handler: (event: GatewayEvent) => void | Promise<void>): () => void;
  /** Emit an event to the gateway */
  emit(
    type: string,
    payload: unknown,
    options?: {
      source?: string;
      connectionId?: string; // Override auto-stamped connectionId
      tags?: string[]; // Override auto-stamped tags
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
  createLogger(options?: {
    component?: string; // e.g. "trace" -> component "my-feature:trace"
    fileName?: string; // e.g. "session-ses_123.log"
  }): LoggerLike;
  /** Persistent JSON-backed store at ~/.anima/<extensionId>/store.json */
  store: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): boolean;
    all(): Record<string, unknown>;
  };
}
```

`ctx.store` persists immediately and supports dot notation, so it is the right place for state that must survive HMR or gateway restarts:

```typescript
ctx.store.set("persistentSessions./repo/general", {
  sessionId: "abc-123",
  messageCount: 1,
  createdAt: new Date().toISOString(),
});
```

### Logging

Use the logger from the extension context. Do not create ad hoc file loggers in module scope.

```typescript
async start(ctx: ExtensionContext) {
  ctx.log.info("My Feature started");

  const traceLog = ctx.createLogger({ component: "trace" });
  traceLog.info("Background worker initialized");

  const sessionLog = ctx.createLogger({
    component: "session",
    fileName: "session-ses_123.log",
  });
  sessionLog.info("Opened scoped session trace");
}
```

Rules:

- Use `ctx.log` for lifecycle, health, startup, shutdown, and coarse operator-visible state changes.
- Use `ctx.log.child("...")` or `ctx.createLogger({ component })` for subcomponents inside one extension.
- Use `ctx.createLogger({ fileName })` for high-frequency or high-cardinality logs that should not flood the main extension log.
- Do not write per-token, per-stream-chunk, or per-message hot-path traces into the main extension log.
- Prefer correlation-scoped files for noisy traces, for example per-session, per-connection, or per-job logs.
- Do not use `appendFileSync`, `console.log`, or custom buffering/rotation for normal extension logging. The shared logger already handles file writes and console routing.

For system-wide policy and log topology, see [LOGGING.md](./LOGGING.md).

### ctx.call() — Cross-Extension Calls

Extensions can call methods on other extensions through the gateway hub:

```typescript
async start(ctx) {
  // Call the session extension to send a prompt
  const result = await ctx.call("session.send_prompt", {
    sessionId: "abc",
    content: "Hello from my extension",
  });

  // Call voice extension to speak
  await ctx.call("voice.speak", { text: "Processing complete" });
}
```

Calls route through the gateway's `ExtensionManager.handleMethod()`, so they go through the same schema validation and routing as client requests. The gateway enforces safety guardrails:

- **Max depth: 8** — prevents infinite call cycles (A calls B calls A...)
- **Deadline propagation** — the original request's deadline carries through the chain
- **Per-extension in-flight cap: 50** — prevents a runaway extension from flooding the hub
- **Trace ID** — all calls in a chain share a trace ID for debugging

The `connectionId` from the originating request is automatically propagated, so downstream extensions know which client triggered the chain.

### Methods (Schema-Driven)

Every method declares a Zod input schema. The gateway validates at the boundary — handlers can assume valid input:

```typescript
{
  name: "voice.speak",           // Format: {extensionId}.{method}
  description: "Synthesize text to speech",
  inputSchema: z.object({
    text: z.string().min(1),
    voice: z.string().optional(),
  }),
}
```

Methods are discoverable via `gateway.list_methods` and auto-generate CLI help.

Naming rule: Multi-word method segments must use snake_case (for example `workspace.get_or_create`, `session.tool_result`).

### Events

Extensions emit events via `ctx.emit()` and subscribe via `ctx.on()`:

```typescript
// Emit to the gateway event bus (reaches all clients + extensions)
ctx.emit("voice.audio_chunk", { audio: base64, streamId });

// Subscribe to events (supports wildcards)
ctx.on("session.content_block_delta", handler); // Exact match
ctx.on("session.*", handler); // Prefix wildcard
ctx.on("*", handler); // All events
```

The `on()` call returns an unsubscribe function. Call it in `stop()`:

```typescript
const unsubs: (() => void)[] = [];

async start(ctx) {
  unsubs.push(ctx.on("session.*", handler));
},

async stop() {
  unsubs.forEach(fn => fn());
}
```

### Tags (Envelope-Level Opt-In)

Tags are opaque strings on the event envelope that callers use to opt into extension-specific capabilities. They are **not** part of method Zod schemas — they travel on the request/event envelope alongside `connectionId`.

**Convention:** `extension.capability` format (e.g., `voice.speak`).

**How tags flow:**

```
Client WS request: { type: "req", method: "session.send_prompt", params: {...}, tags: ["voice.speak"] }
  → Gateway forwards tags on NDJSON envelope to extension host
  → Extension host sets currentTags from envelope
  → All events emitted during request handling auto-stamp tags
  → Downstream extensions check event.tags to activate optional behavior
```

Tags propagate automatically through the event bus — just like `connectionId`. Extensions don't need to explicitly forward tags; the extension host's `currentTags` mechanism handles it.

**Checking tags in an extension:**

```typescript
ctx.on("session.*.content_block_start", async (event) => {
  if (!event.tags?.includes("voice.speak")) return;
  // Activate voice for this response
});
```

**Sending tags from a client:**

```typescript
// Include tags on the WS request envelope (outside params)
ws.send(
  JSON.stringify({
    type: "req",
    id: uuid(),
    method: "session.send_prompt",
    params: { sessionId, content, model, thinking, effort },
    tags: ["voice.speak"],
  }),
);
```

**Overriding tags on emit:**

Extensions can override auto-stamped tags when emitting, just like connectionId:

```typescript
ctx.emit("my-ext.event", payload, {
  connectionId: specificConnectionId, // Override auto-stamped connectionId
  tags: ["custom.tag"], // Override auto-stamped tags
  source: "gateway.caller", // Route only to the specific connection
});
```

**Known tags:**

| Tag           | Extension | Purpose                                                                                                            |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `voice.speak` | voice     | Activates TTS for the response. Audio is routed only to the requesting client via `gateway.caller` + connectionId. |

Tags are designed to be lightweight and composable. Multiple tags can be sent on a single request, enabling multiple extensions to activate independently.

### Health Check

Every extension should expose a `{id}.health_check` method returning `HealthCheckResponse`. Mission Control discovers and renders these generically:

```typescript
interface HealthCheckResponse {
  ok: boolean;
  status: "healthy" | "degraded" | "disconnected" | "error";
  label: string; // Card title
  metrics?: { label: string; value: string | number }[];
  actions?: HealthAction[]; // Buttons (kill, restart, etc.)
  items?: HealthItem[]; // Per-resource rows (sessions, connections)
}
```

### Source Routing

For extensions bridging external systems, the most common pattern is to call another extension directly and keep any durable routing state in `ctx.store`.

The current iMessage flow is a good example:

1. iMessage receives an external message
2. The extension builds `source: "imessage/<chatId>"`
3. It calls `ctx.call("session.send_prompt", { sessionId: PERSISTENT_SESSION_ID, cwd, content, source })`
4. The session extension resolves the real shared session for that `cwd`
5. The iMessage extension sends the returned text back over iMessage

`sourceRoutes` and `handleSourceResponse()` are still available when an extension truly needs gateway-level response routing, but they are not required for the common iMessage-style request/reply path anymore.

---

## Configuration

### anima.json

Extension config lives in `~/.anima/anima.json` (JSON5 format):

```json5
{
  extensions: {
    voice: {
      enabled: true,
      sourceRoutes: ["imessage"], // Optional: override source routes
      config: {
        apiKey: "${CARTESIA_API_KEY}", // Env var interpolation
        voiceId: "${CARTESIA_VOICE_ID}",
        model: "sonic-3",
        streaming: true,
        emotions: ["positivity:high", "curiosity"],
        speed: 1.0,
      },
    },
  },
}
```

### Config Flow

```
~/.anima/anima.json
  -> loadConfig() interpolates ${ENV_VARS} from process.env / .env
  -> gateway start.ts enumerates enabled extension IDs
  -> resolves extensions/<id>/src/index.ts
  -> spawns: bun --hot extensions/<id>/src/index.ts <config-json>
  -> extension calls runExtensionHost(factory) -> factory(config)
  -> host sends register message with metadata (methods, events, sourceRoutes)
  -> gateway registers the remote extension before start() finishes
  -> extension start() can subscribe to gateway.extensions_ready for startup work that depends on other extensions
```

**Important**: Don't read `process.env` in your extension defaults. The config object passed to your factory already has interpolated values. Reading `process.env` directly breaks out-of-process mode because the child process may not have the same environment.

```typescript
// BAD — breaks in extension host
const DEFAULT_CONFIG = {
  apiKey: process.env.MY_API_KEY || "", // Empty in child process!
};

// GOOD — config comes from the factory parameter
export function createMyExtension(config: MyConfig = {}): AnimaExtension {
  const cfg = { ...DEFAULTS, ...config }; // Config has interpolated values
}
```

### Environment Variables

Put secrets in a `.env` file at the project root (gitignored). Bun auto-loads it:

```bash
# .env
CARTESIA_API_KEY=sk-...
CARTESIA_VOICE_ID=931fb722-...
```

Reference them in `anima.json` via `${VAR_NAME}` syntax.

---

## Out-of-Process Extensions

### Why

When developing, `bun --watch` restarts the gateway on any code change. If voice extension code changes, the gateway restarts, killing all WebSocket connections. Out-of-process extensions run in separate child processes — gateway stays alive, connections survive.

### How It Works

```
Gateway (port 30086)
  |-- Child: bun --hot extensions/voice/src/index.ts <config-json>
  |-- Child: bun --hot extensions/imessage/src/index.ts <config-json>
  |-- Child: bun --hot extensions/chat/src/index.ts <config-json>
  `-- (one process per enabled extension)
        `-- stdin/stdout NDJSON <-> gateway
```

Each extension is directly executable. The gateway:

1. Reads enabled extensions from config
2. Resolves each entrypoint as `extensions/<id>/src/index.ts`
3. Spawns `bun --hot extensions/<id>/src/index.ts <config-json>`
4. The extension host creates the extension via `factory(config)` and immediately sends a `register` message with method/event metadata
5. Gateway registers the remote extension so other extensions can call it during startup
6. The host then runs `extension.start(ctx)`
7. After all enabled extensions have registered, the gateway broadcasts `gateway.extensions_ready`

There is no generic host shim or dynamic import layer. The extension IS the process entry point. `runExtensionHost()` (from `@anima/extension-host`) handles the stdio protocol, console redirection, event bus bridging, parent liveness detection, and HMR lifecycle.

### Singleton Host Enforcement (Gateway-Wide)

The gateway enforces one live process per extension ID using DB-backed singleton locks (`extension_process_locks`):

- Lock is acquired before spawn.
- Fresh lock owned by another gateway instance blocks spawn.
- Stale locks are stolen automatically.
- Running hosts renew lock heartbeats.
- If heartbeat renewal fails, the gateway stops that extension host.

This applies to all extensions (voice, memory, session, etc.) without per-extension code.

### Gateway-Owned Runtime Liveness Locks

Recovery-relevant extension locks are also moving into gateway ownership.

This is a second lock layer, separate from host-process singleton enforcement:

- `extension_process_locks`
  gateway host-process ownership
- `extension_runtime_locks`
  extension runtime liveness / recovery ownership

Extensions reach those through gateway methods rather than private tables:

- `gateway.acquire_liveness_lock`
- `gateway.renew_liveness_lock`
- `gateway.release_liveness_lock`
- `gateway.list_liveness_locks`

The first concrete migration is `memory` singleton ownership. That lock is now gateway-managed so watchdog can reason about it without inspecting memory internals.

### NDJSON Protocol

Communication happens over stdin/stdout with newline-delimited JSON:

```
Gateway -> Host (method call)
{"type":"req","id":"abc","method":"voice.speak","params":{"text":"hello"}}

Host -> Gateway (response)
{"type":"res","id":"abc","ok":true,"payload":{"status":"ok"}}

Gateway -> Host (event forwarding)
{"type":"event","event":"session.content_block_delta","payload":{...}}

Host -> Gateway (event from extension)
{"type":"event","event":"voice.audio_chunk","payload":{...}}

Host -> Gateway (cross-extension call via ctx.call)
{"type":"call","id":"def","method":"session.send_prompt","params":{...},"depth":1,"traceId":"..."}

Gateway -> Host (call response)
{"type":"call_res","id":"def","ok":true,"payload":{...}}

Host -> Gateway (registration on startup)
{"type":"register","extension":{"id":"voice","name":"Voice (TTS)","methods":[...],"events":[...],"sourceRoutes":[]}}
```

### Hot Module Reload

Since the extension IS the entry point, `bun --hot` covers all code changes natively. No file watchers, no cache busting, no indirection. Edit, save, it reloads.

When extension code changes:

1. Bun detects the file change
2. `import.meta.hot.dispose()` calls `extension.stop()` on the old instance
3. The module re-executes — `runExtensionHost()` re-creates the extension via the factory
4. Stdio connection to gateway is unbroken (the process stays alive)
5. New `register` message sent with updated metadata
6. Gateway re-registers the extension (old registration is cleaned up automatically)
7. Gateway sends `gateway.extensions_ready` again to that extension so it can re-run startup work that depends on peers

The `runExtensionHost()` implementation tracks stdin binding across HMR cycles via `import.meta.hot.data` to avoid duplicate listeners.

### Generation Tokens and Stale Event Filtering

Each host spawn has a generation token. The gateway tracks the latest token per extension and drops events coming from older generations.

This prevents duplicate fanout during restart/HMR races where an older lifecycle may still emit briefly.

### Manual Restart (gateway.restart_extension)

For extensions running with `hot: false`, use `gateway.restart_extension` to restart them without restarting the entire gateway:

```bash
anima gateway restart_extension --extension session
```

This kills the extension host process and re-spawns it. The extension re-registers with the gateway automatically. Other extensions and WebSocket connections are unaffected.

### Auto-Restart

If the extension process crashes, the gateway automatically restarts it (up to 5 times with 2-second delays). Pending method calls are rejected with an error.

### Orphan Detection

On startup, the gateway kills orphaned extension host processes from previous instances. When `bun --watch` restarts the gateway via SIGKILL, cleanup handlers don't run, so child processes can be orphaned. The gateway uses `pgrep -f "extensions/.*/src/index.ts"` to find and terminate them.

Extension hosts also self-monitor: they poll `process.ppid` every 2 seconds and exit if the parent PID changes (indicating they were reparented to PID 1/launchd).

### Out-of-Process Readiness Checklist

Before enabling an extension, verify all of these:

1. Entry point exists at `extensions/<id>/src/index.ts` with the `runExtensionHost()` call at the bottom.
2. `package.json` includes `"@anima/extension-host": "workspace:*"` in dependencies.
3. Runtime config comes from the factory `config` argument (or `ctx.config`), not module-level `loadConfig()`/`process.env` reads.
4. `start()`/`stop()` fully clean up timers, sockets, subprocesses, and event subscriptions so HMR does not leak state.
5. Keep server logic and route/page logic split: server code runs out-of-process while React routes still load in the gateway web shell.

### Console Output

In the extension host, **stdout is reserved for NDJSON**. `runExtensionHost()` redirects `console.log/warn/error` to stderr automatically. The shared logger writes to both console and file, so this happens transparently. Extension authors don't need to worry about it.

---

## WebSocket Client Protocol

Any client connecting to the gateway WebSocket (`ws://localhost:30086/ws`) must implement the ping/pong protocol to stay alive. This applies to browser UIs, Chrome extensions, native apps — anything with a WebSocket connection.

### Ping/Pong (Required)

The gateway sends ping messages every 30 seconds. Clients that miss 2 consecutive pings (60s without a pong) are pruned — their connection is closed and a `client.disconnected` event is broadcast to all extensions.

```typescript
// Gateway -> Client (every 30s)
{ "type": "ping", "id": "uuid", "timestamp": 1234567890 }

// Client -> Gateway (must respond)
{ "type": "pong", "id": "uuid" }
```

Implementation is simple — intercept pings before your normal message handler:

```typescript
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", id: data.id }));
    return;
  }

  // ... handle other messages
};
```

### Connection ID

Every WebSocket connection is assigned a unique `connectionId` by the gateway (sent in the `gateway.welcome` event on connect). This ID is stamped on the request and event envelopes as they flow through the system, so extensions can identify which connection originated a request or event.

```typescript
// Sent on connect
{ "type": "event", "event": "gateway.welcome", "payload": { "connectionId": "abc-123" } }

// Requests carry connectionId through the pipeline
{ "type": "req", "id": "...", "method": "dominatrix.register", "params": {...}, "connectionId": "abc-123" }

// Events also carry connectionId
{ "type": "event", "event": "client.disconnected", "payload": {}, "connectionId": "abc-123" }
```

Extensions receive `connectionId` via `params._connectionId` for method calls and `event.connectionId` for events. This enables connection-scoped routing (e.g., voice audio only goes to the tab that requested it).

### Exclusive Subscriptions

Standard subscriptions broadcast events to all matching clients. Exclusive subscriptions ensure only the **last subscriber** receives matching events — previous exclusive subscribers are silently replaced.

```typescript
// Standard — all subscribers get the event
{ "type": "req", "method": "subscribe", "params": { "events": ["session.*"] } }

// Exclusive — last subscriber wins
{ "type": "req", "method": "subscribe", "params": { "events": ["dominatrix.command"], "exclusive": true } }
```

Use case: multiple Chrome profiles each have a DOMINATRIX extension subscribed to `dominatrix.command`. With exclusive subscriptions, only the last-focused profile handles commands. Clicking a different Chrome window re-subscribes that profile as the exclusive handler.

### Client Disconnect Events

When a WebSocket connection closes (or is pruned by ping timeout), the gateway broadcasts a `client.disconnected` event to all extensions:

```typescript
{ "type": "event", "event": "client.disconnected", "payload": {}, "connectionId": "abc-123" }
```

Extensions that track connected clients (like DOMINATRIX tracking Chrome extension instances) use this to clean up stale entries automatically.

---

## Web Pages (Client-Side Routes)

Extensions can serve web pages via the gateway's SPA.

### Add routes.ts

```typescript
// extensions/my-feature/src/routes.ts
import type { ExtensionWebContribution, Route } from "@anima/ui";
import { MyPage } from "./pages/MyPage";

export const myFeatureRoutes: Route[] = [
  { path: "/my-feature", component: MyPage, label: "My Feature" },
];

export default {
  id: "my-feature",
  name: "My Feature",
  routes: myFeatureRoutes,
} satisfies ExtensionWebContribution;
```

### Export from package.json

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./routes": "./src/routes.ts"
  },
  "dependencies": {
    "@anima/extension-host": "workspace:*",
    "@anima/shared": "workspace:*",
    "@anima/ui": "workspace:*",
    "zod": "^3.25.76"
  }
}
```

### Register in the web shell

Route modules are collected through `packages/gateway/src/web/extension-web-contributions.generated.ts`.
Refresh it after adding or removing an extension route file:

```bash
bun run web:routes
```

`@anima/gateway` runs this generator before `dev` and `build`, so normal gateway startup picks up new route modules automatically.

### Convention

- Chat owns `/` (workspaces, sessions)
- Other extensions use `/{extension-name}` paths
- Pages are React components using `@anima/ui` hooks (`useChatGateway`, `useGatewayClient`, `useRouter`)

### Gateway URL Defaults (Web Extensions)

For extension web pages, `useGatewayClient()` now accepts an optional URL:

```tsx
const { call, isConnected } = useGatewayClient();
```

When omitted, it connects to the same host serving the page and selects protocol automatically:

- `https://...` page → `wss://<host>/ws`
- `http://...` page → `ws://<host>/ws`

You can still pass an explicit URL when needed. `http://`/`https://` inputs are normalized to `ws://`/`wss://` internally.

### Shared Gateway Socket (Per Tab)

The gateway web app wraps routes in `GatewayClientProvider`, which maintains a single shared WebSocket per browser tab.

- `useGatewayClient()` reuses this shared connection by default
- Client-side route navigation between extensions/pages does not force reconnects
- Full page reload/new tab creates a new socket (expected)

Chat still manages session scope explicitly (`session.<id>.*`) and unsubscribes on session switch/unmount.

---

## Existing Extensions

| Extension       | ID           | Package                 | Web Pages                                         | Source Routes |
| --------------- | ------------ | ----------------------- | ------------------------------------------------- | ------------- |
| Chat            | `chat`       | `@anima/ext-chat`       | `/`, `/workspace/:workspaceId/session/:sessionId` | --            |
| Voice           | `voice`      | `@anima/voice`          | --                                                | --            |
| iMessage        | `imessage`   | `@anima/ext-imessage`   | --                                                | `imessage`    |
| Mission Control | `control`    | `@anima/ext-control`    | `/control`, `/logs`                               | --            |
| Hooks           | `hooks`      | `@anima/ext-hooks`      | --                                                | --            |
| DOMINATRIX      | `dominatrix` | `@anima/ext-dominatrix` | --                                                | --            |

All extensions run out-of-process. There is no in-process mode.

---

## Hooks

Hooks are lightweight event-driven scripts that run inside the **hooks extension**. Instead of building a full extension for simple reactive features, drop a `.ts` file into a hooks directory and it will be loaded automatically.

### How It Works

The hooks extension (`extensions/hooks/`) loads hooks from:

1. `~/.anima/hooks/` — user-level hooks (apply to all workspaces)
2. `<workspace>/.anima/hooks/` — workspace-level hooks for the active workspace

If multiple hook files share the same filename (same hook ID), workspace hooks override user hooks.

Each `.ts` or `.js` file must default-export a `HookDefinition`:

```typescript
import type { HookDefinition } from "@anima/shared";

export default {
  event: "session.message_stop", // or an array: ["session.message_stop", "session.history_loaded"]
  description: "What this hook does",

  async handler(ctx, payload) {
    // ctx: HookContext with emit(), workspace, sessionId, log
    // payload: optional event payload from the gateway
  },
} satisfies HookDefinition;
```

### HookContext

Every handler receives a `HookContext`:

```typescript
interface HookContext {
  /** Emit an event (namespaced as hook.{hookId}.{eventName}) */
  emit(event: string, payload: unknown): void;
  /** Current workspace info */
  workspace: { cwd: string } | null;
  /** Current session ID */
  sessionId: string | null;
  /** Logger */
  log: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}
```

When a hook calls `ctx.emit("files", data)`, the gateway broadcasts `hook.{hookId}.files` to all subscribed WebSocket clients. The hook ID is derived from the filename (e.g., `git-status.ts` -> `git-status`).

### Available Events

Hooks can subscribe to any gateway event. Common ones:

| Event                         | When it fires                                           |
| ----------------------------- | ------------------------------------------------------- |
| `session.message_stop`        | After Claude finishes a response                        |
| `session.message_start`       | When Claude starts responding                           |
| `session.content_block_delta` | Each streaming text chunk                               |
| `session.history_loaded`      | When a client loads session history (page load/refresh) |
| `session.*`                   | Wildcard for all session events                         |

Pattern matching is first-match per hook. Exact patterns are evaluated before wildcard patterns, and `*` is evaluated last. A hook runs at most once per incoming event even if multiple patterns match.

### UI Integration -- Status Bar

Hook output is rendered in the **StatusBar** component, a compact bar between the chat messages and input area. The UI subscribes to `hook.*` events and stores the latest payload per hook ID in `hookState`.

The StatusBar currently renders:

- **Git branch** — icon + branch name (always visible when hook data exists)
- **Change badges** — `+N` (green), `~N` (amber), `-N` (red), `!N` (purple)
- **Expandable file list** — click badges to see individual changed files

To add a new hook with UI rendering, emit data via `ctx.emit()` and add a corresponding renderer in `StatusBar.tsx`.

### Example: git-status Hook

```typescript
// .anima/hooks/git-status.ts
import type { HookDefinition } from "@anima/shared";

interface GitStatusPayload {
  branch: string;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  total: number;
  files: { status: string; path: string }[];
}

export default {
  event: ["session.message_stop", "session.history_loaded"],
  description: "Show git file changes after each turn",

  async handler(ctx) {
    const cwd = ctx.workspace?.cwd;
    if (!cwd) return;

    // Run git commands and parse porcelain output...
    const payload: GitStatusPayload = {
      branch: "main",
      modified: 0,
      added: 0,
      deleted: 0,
      untracked: 0,
      total: 0,
      files: [],
    };

    ctx.emit("files", payload);
  },
} satisfies HookDefinition;
```

If the workspace CWD is not a git repository, the hook exits early and emits nothing.

Hook handler signature is `handler(ctx, payload?)`: `ctx` is required and `payload` is optional.

### Configuration

Enable the hooks extension in `~/.anima/anima.json`:

```json5
{
  extensions: {
    hooks: {
      enabled: true,
      config: {
        // Optional: additional directories to scan
        // extraDirs: ["/path/to/more/hooks"]
      },
    },
  },
}
```

### Hook Ideas

- **Cost tracker** — accumulate API usage from `session.message_stop` payloads, display running total
- **Build status** — run `tsc --noEmit` after changes, show pass/fail
- **Test runner** — run relevant tests after file changes
- **Session timer** — track time spent per session

---

## File Structure

```
extensions/<name>/
├── package.json           # Exports: . -> ./src/index.ts, ./routes (if has UI)
└── src/
    ├── index.ts           # Factory + implementation + runExtensionHost() call
    ├── routes.ts          # Route declarations (if has UI)
    └── pages/             # React page components (if has UI)
        └── MyPage.tsx

.anima/
└── hooks/                   # Workspace-level hook scripts (loaded by hooks extension)
    ├── git-status.ts        # Git status after each turn
    └── ...

packages/
├── shared/src/types.ts              # AnimaExtension, ExtensionContext, HookDefinition, etc.
├── shared/src/config.ts             # Config loading + env interpolation
├── gateway/src/start.ts             # Config-driven extension startup (spawns extensions directly)
├── gateway/src/extensions.ts        # ExtensionManager (routing, events, lifecycle)
├── gateway/src/extension-host.ts    # ExtensionHostProcess (child process management)
├── gateway/src/web/index.tsx        # SPA shell (route collection)
├── ui/src/components/StatusBar.tsx  # Hook output rendering (git badges, etc.)
└── extension-host/src/index.ts      # runExtensionHost() — NDJSON stdio protocol + HMR lifecycle
```

---

## Testing

Extensions can be tested in isolation. See `extensions/control/src/index.test.ts` for an example:

```typescript
import { describe, expect, test } from "bun:test";
import { createMyFeatureExtension } from "./index";

describe("my-feature", () => {
  test("handles do-thing method", async () => {
    const ext = createMyFeatureExtension({
      /* config */
    });
    await ext.start(mockContext);

    const result = await ext.handleMethod("my-feature.do_thing", { input: "hello" });
    expect(result).toEqual({ status: "ok", result: "..." });
  });
});
```

Use the CLI for integration testing against a running gateway:

```bash
bun run packages/cli/src/index.ts my-feature.health_check
bun run packages/cli/src/index.ts my-feature.do_thing --input "test"
```
