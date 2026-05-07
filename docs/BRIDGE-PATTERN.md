# Bridge Extension Pattern

How to integrate Anima with a runtime that lives **outside the gateway** — a browser, a code-server / VS Code instance, a native desktop app, a remote machine. Anima talks to it like a first-class extension while the actual logic runs in the foreign process.

This pattern is the reason `anima call dominatrix.click {...}` works against a real Chrome tab, and the reason `anima call editor.open_file {...}` pops a file open in code-server. Same shape, two different runtimes.

## When to use this

Use a bridge extension when:

- The thing you want to drive **lives in a foreign runtime** that the gateway can't import or call directly (browser process, VS Code extension host, a CLI agent over SSH, etc.)
- You want **every Anima client** — chat, CLI, voice, MCP, iOS, menubar — to drive it through the same surface, with the same auth, validation, and observability the rest of Anima already enforces
- You want **spontaneous events** from that runtime (e.g. "active editor changed", "tab navigated") to fan out to subscribers as first-class gateway events
- You want the operation to **show up in `gateway.list_methods`** and the auto-generated API reference, and become MCP-callable for free

Don't use this pattern when:

- The logic can run in-process — write a regular [extension](./EXTENSIONS.md) and skip the wire protocol entirely
- You only need a one-off script — overkill
- The remote side has no persistent process (use HTTP webhooks or scheduled tasks instead)

## Architecture

A bridge extension comes in **two halves**:

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Caller          │       │  Server          │       │  Remote runtime  │
│  (chat, CLI,     │       │  extension       │       │  (Chrome,        │
│   voice, MCP,    │       │  (in-process)    │       │   code-server,   │
│   any client)    │       │                  │       │   etc.)          │
│                  │       │                  │       │                  │
│  ext.method(p)   ├──────►│  emits           ├──────►│  client          │
│                  │       │  ext.command     │       │  subscribed      │
│                  │       │  event w/        │       │  exclusively     │
│                  │       │  requestId       │       │                  │
│                  │       │                  │       │                  │
│                  │       │  awaits          │       │  runs action,    │
│                  │       │  matching        │       │  posts back via  │
│                  │       │  ext.response    │       │  ext.response    │
│  resolves()      │◄──────┤  by requestId    │◄──────┤                  │
└──────────────────┘       └──────────────────┘       └──────────────────┘
                                    ▲
                                    │  spontaneous events from the
                                    │  remote runtime via ext.notify_*
                                    │
                           re-emitted as ext.<thing>_changed
                           events to all subscribers
```

The **server extension** runs in-process (a normal `AnimaExtension`). It owns the public method surface, validates input, dispatches commands as events, and correlates responses. It never touches the foreign runtime directly.

The **remote client** runs inside the foreign runtime. It's a regular WebSocket client of the gateway — same wire protocol every other Anima client uses. It subscribes to commands, executes them locally, and replies via methods on the server extension.

The gateway is the seam. It already handles auth, transport, fanout, and ping/pong heartbeats — bridge extensions ride on all of that for free.

## Wire protocol

Every bridge extension uses the same five method/event shapes (replace `<ext>` with the extension ID):

| Shape                   | Direction    | Purpose                                                                                                            |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `<ext>.<public_method>` | caller → ext | The user-facing API. Validated by Zod. Internally calls `sendCommand(action, params)` and awaits a response.       |
| `<ext>.command` event   | ext → client | Dispatched action, payload `{ requestId, action, params }`. Clients subscribe **exclusively** to this single name. |
| `<ext>.response` method | client → ext | Reply correlated by `requestId`. Payload `{ requestId, success, data?, error? }`.                                  |
| `<ext>.register` method | client → ext | A client claims a slot. Payload typically includes a stable `instanceId` and runtime metadata (version, etc.).     |
| `<ext>.notify_<thing>`  | client → ext | The remote runtime pushes a spontaneous event upward. The extension re-emits as `<ext>.<thing>_changed`.           |

The server extension also exposes the standard `<ext>.health_check` method that reports connected client count.

The choice to use **one `command` event with an `action` field** (rather than one event per action like `<ext>.requests.click`) is deliberate: the client subscribes to a single event name and dispatches internally. Adding new actions doesn't require new subscriptions.

## Authoring the server extension

A bridge extension is an ordinary `AnimaExtension` — same factory shape, same lifecycle, same testing harness as in the [Extensions guide](./EXTENSIONS.md). The bridge-specific bits are concentrated in the dispatch core.

### Core data structures

```ts
interface RemoteClient {
  instanceId: string;
  connectionId: string; // gateway-assigned, used for disconnect cleanup
  registeredAt: number;
  // ... runtime-specific metadata (version, profile name, tab id, etc.)
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  action: string; // for logs / diagnostics
}

const COMMAND_TIMEOUT_MS = 15_000;

const clients = new Map<string, RemoteClient>(); // instanceId → client
const pendingRequests = new Map<string, PendingRequest>(); // requestId → in-flight
const connectionMap = new Map<string, string>(); // connectionId → instanceId
```

### sendCommand — the heart of the dispatch

```ts
function sendCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (clients.size === 0) {
    return Promise.reject(new Error("No <ext> bridge connected"));
  }

  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`<ext> command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, reject, timer, action });
    ctx.emit("<ext>.command", { requestId, action, params });
  });
}
```

The pattern: every public method just calls `sendCommand(action, params)`. The method name maps to the action string; the body is one line.

### Public methods

```ts
const methods = {
  "<ext>.do_thing": (p) => sendCommand("do_thing", p),
  "<ext>.read_thing": (p) => sendCommand("read_thing", p),
  // ... one line per action
};
```

### `<ext>.register` — claim a slot

```ts
"<ext>.register": async (p) => {
  const instanceId = p.instanceId as string;
  const connectionId = ctx.connectionId;
  if (!connectionId) {
    throw new Error("<ext>.register requires a client connection");
  }

  // If this connection had a previous registration, evict the old one first
  // (handles client reload / hot-restart cases).
  const previousInstanceId = connectionMap.get(connectionId);
  if (previousInstanceId && previousInstanceId !== instanceId) {
    clients.delete(previousInstanceId);
  }

  clients.set(instanceId, {
    instanceId,
    connectionId,
    registeredAt: Date.now(),
    // ... extra fields from p
  });
  connectionMap.set(connectionId, instanceId);

  return { ok: true };
},
```

### `<ext>.response` — resolve the pending request

```ts
"<ext>.response": async (p) => {
  const requestId = p.requestId as string;
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    return { ok: false }; // ghost response — log and ignore
  }

  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);

  if (p.success) {
    pending.resolve(p.data ?? null);
  } else {
    pending.reject(new Error((p.error as string) || `<ext> command '${pending.action}' failed`));
  }
  return { ok: true };
},
```

### `<ext>.notify_*` — spontaneous events

```ts
"<ext>.notify_active_thing": async (p) => {
  ctx.emit("<ext>.active_thing_changed", { thing: p.thing });
  return { ok: true };
},
```

Subscribers (chat, CLI, hooks) listen on `<ext>.active_thing_changed` directly — they never need to know about the `notify_*` plumbing.

### Disconnect cleanup

Subscribe to the gateway's built-in `client.disconnected` event in `start()`:

```ts
async start(extensionCtx) {
  ctx = extensionCtx;

  ctx.on("client.disconnected", (event) => {
    const connectionId = event.connectionId;
    if (!connectionId) return;
    const instanceId = connectionMap.get(connectionId);
    if (!instanceId) return;
    clients.delete(instanceId);
    connectionMap.delete(connectionId);
  });
}
```

When the WebSocket drops (page reload, network blip, code-server restart), the registration evaporates automatically.

### Stop hygiene

In `stop()`, reject every in-flight request so callers don't hang forever:

```ts
async stop() {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("<ext> shutting down"));
    pendingRequests.delete(id);
  }
  clients.clear();
  connectionMap.clear();
}
```

### Schema-first methods

Define a Zod schema for every public method and every internal method. The gateway validates at the boundary — handlers never see invalid input:

```ts
const openParam = z.object({
  path: z.string().describe("Absolute path"),
  line: z.number().int().positive().optional(),
});

const responseParam = z.object({
  requestId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
```

Internal methods (`register`, `response`, `notify_*`) are typically tagged with `execution: { lane: "control", concurrency: "parallel" }` so they don't queue behind heavyweight calls.

## Authoring the remote client

The client is whatever the foreign runtime expects — a Chrome extension, a VS Code extension, a daemon, a native app. Wherever it runs, the responsibilities are the same:

1. Open a WebSocket to the gateway, with the bearer token from anima.json (typical pattern: `?token=<token>` query param)
2. On open, send `gateway.subscribe { events: ["<ext>.command"], exclusive: true }`
3. Send `<ext>.register { instanceId, ...metadata }` with a **stable** `instanceId` persisted across restarts (Chrome's `chrome.storage`, VS Code's `globalState`, a config file, etc.)
4. On every `<ext>.command` event, run the action locally and reply with `<ext>.response { requestId, success, data?, error? }`
5. For spontaneous events, send `<ext>.notify_<thing>` with the new state
6. Reply to `ping` messages with `pong` immediately or the gateway will eventually close the socket
7. Auto-reconnect on close — instanceId persistence lets the server extension recognise the same client returning

A minimal client core looks roughly like this:

```ts
ws.on("open", () => {
  send("gateway.subscribe", { events: ["<ext>.command"], exclusive: true });
  send("<ext>.register", { instanceId /* metadata */ });
});

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", id: msg.id }));
    return;
  }
  if (msg.type !== "event" || msg.event !== "<ext>.command") return;

  const { requestId, action, params } = msg.payload;
  try {
    const data = await dispatch(action, params);
    send("<ext>.response", { requestId, success: true, data });
  } catch (err) {
    send("<ext>.response", {
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
```

## Key invariants

These are the non-obvious correctness rules the pattern depends on. Break any of them and you get heisenbugs:

1. **Exclusive subscription on the client.** `gateway.subscribe { exclusive: true }` means the most recent subscriber wins. Without this, two open code-server tabs both fire `vscode.commands.executeCommand` and you get duplicate file opens.

2. **Stable, persisted `instanceId`.** Generate once and persist client-side. The server uses it as the key for the clients map, so a fresh uuid every reconnect would orphan the old registration until disconnect cleanup catches up.

3. **`requestId` correlation, never positional.** Multiple commands can be in-flight; responses can return in any order. Always look up by `requestId` in the pending map.

4. **Per-request timeout.** Network blips and remote-runtime hangs are unavoidable. The 15s default is generous for human-paced actions; tune as needed but never set it to infinity.

5. **Disconnect cleanup via `client.disconnected`.** Without this, dead registrations linger and `health_check` lies. The pattern: server keeps a `connectionId → instanceId` map, evicts both on disconnect.

6. **Re-register evicts.** If the same `connectionId` re-registers with a different `instanceId`, drop the old one first. Handles hot-restart of the client without leaking entries.

7. **Reject pending on stop.** The extension can be torn down (gateway shutdown, HMR). Don't leave callers hanging; reject every pending promise with a clean error.

## What you get for free

By routing through the gateway, a bridge extension picks up every gateway feature without writing new code:

| Feature                      | How it works                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| **Multi-client access**      | Chat, CLI, voice, MCP, iOS, menubar all call the same methods                                    |
| **Auth**                     | Gateway token in the WS URL covers the bridge with the same auth as everything else              |
| **Schema validation**        | Zod schemas on the server extension validate every call before dispatch                          |
| **Spontaneous event fanout** | Every gateway subscriber sees the re-emitted event                                               |
| **Health check surface**     | `<ext>.health_check` shows up in Mission Control just like any other extension                   |
| **Observability**            | Every method call lands in the gateway logs; `editor-trace.log` style trace logs are easy to add |
| **MCP tool exposure**        | When the gateway's MCP proxy is enabled, public methods become MCP-callable for the agent        |
| **API reference auto-gen**   | All public methods land in `docs/API-REFERENCE.md` from the Zod schemas                          |

## Examples in the codebase

| Pattern instance                                     | Public methods                                                     | Notes                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `extensions/dominatrix/` + `clients/dominatrix/`     | 36 methods — `snapshot`, `click`, `fill`, `navigate`, …            | Chrome extension; per-tab content scripts; "last focused window wins" via re-subscribe on focus         |
| `extensions/editor/` + `clients/code-server-bridge/` | 3 public methods — `open_file`, `get_selection`, `get_active_file` | VS Code extension `.vsix` installed in code-server; Bun-bundled with `ws` inlined; status bar indicator |

See [DOMINATRIX.md](./DOMINATRIX.md) and [EDITOR.md](./EDITOR.md) for the runtime-specific surfaces.

## Cost / size in practice

A typical bridge extension is ~300-700 LOC of server code plus ~300-1000 LOC of remote client code, and most of that is action handlers — the dispatch / register / response / disconnect plumbing is ~150 LOC and identical between bridges. Future bridges (terminal control, native menubar control, remote macOS automation, etc.) should copy this structure verbatim.

If you're authoring a new bridge and find yourself diverging from the wire-protocol shape above, stop and reconsider — the divergence usually means a tooling gap (e.g. spontaneous events should be re-emitted via `notify_*`, not posted directly as a custom event). Stick to the shape and the rest of Anima slots into place automatically.
