# DOMINATRIX Architecture

Browser automation through a Chrome extension that bridges Anima's gateway to live browser tabs. Commands flow from CLI/API through the gateway to the Chrome extension's content scripts.

## Connection Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  CLI / Agent  │     │   Gateway    │     │  Chrome Extension │     │  Content      │
│  (dominatrix  │     │   :30086     │     │  (background.ts)  │     │  Script       │
│   commands)   │     │              │     │                    │     │  (per tab)    │
└──────┬───────┘     └──────┬───────┘     └────────┬───────────┘     └──────┬───────┘
       │                     │                      │                        │
       │  req: dominatrix.   │                      │                        │
       │  snapshot           │                      │                        │
       ├────────────────────►│                      │                        │
       │                     │                      │                        │
       │                     │  Extension host      │                        │
       │                     │  dispatches via       │                        │
       │                     │  sendCommand()       │                        │
       │                     │                      │                        │
       │                     │  ctx.emit(           │                        │
       │                     │   "dominatrix.       │                        │
       │                     │    command",         │                        │
       │                     │   {requestId,        │                        │
       │                     │    action})          │                        │
       │                     │                      │                        │
       │                     │  broadcastEvent()    │                        │
       │                     │  (to subscribers)    │                        │
       │                     ├─────────────────────►│                        │
       │                     │                      │                        │
       │                     │                      │  chrome.tabs.          │
       │                     │                      │  sendMessage()         │
       │                     │                      ├───────────────────────►│
       │                     │                      │                        │
       │                     │                      │                        │  Execute in
       │                     │                      │                        │  page DOM
       │                     │                      │                        │
       │                     │                      │  Response via          │
       │                     │                      │  chrome.runtime        │
       │                     │                      │◄───────────────────────┤
       │                     │                      │                        │
       │                     │  req: dominatrix.    │                        │
       │                     │  response            │                        │
       │                     │  {requestId,         │                        │
       │                     │   success, data}     │                        │
       │                     │◄─────────────────────┤                        │
       │                     │                      │                        │
       │                     │  Extension host      │                        │
       │                     │  resolves pending    │                        │
       │                     │  promise             │                        │
       │                     │                      │                        │
       │  res: {data}        │                      │                        │
       │◄────────────────────┤                      │                        │
       │                     │                      │                        │
```

### Key Insight: Commands Use Events, Responses Use Methods

The protocol is asymmetric by design:

- **Commands** (gateway → Chrome): Emitted as `dominatrix.command` **events** via the gateway event bus. The Chrome extension receives these because it subscribes to `dominatrix.command` on its WebSocket connection.
- **Responses** (Chrome → gateway): Sent as `dominatrix.response` **method calls** (regular `req` messages). The gateway routes these to the dominatrix extension host, which resolves the pending promise.

This means commands broadcast to ALL subscribed Chrome extension clients, but only one needs to respond.

---

## Chrome Extension Lifecycle

### Service Worker Startup

```
Chrome starts/restarts service worker
  │
  ├─ new DominatrixBackground()
  │    └─ this.instanceId = crypto.randomUUID()  ← NEW ID each time
  │
  ├─ connect() → WebSocket to ws://localhost:30086/ws
  │
  ├─ onopen:
  │    ├─ subscribe({events: ["dominatrix.command"]})
  │    └─ dominatrix.register({extensionId, instanceId, profileName})
  │
  └─ onclose:
       └─ scheduleReconnect() → retry after 3s
```

### Registration in Extension

```typescript
// dominatrix extension (server-side)
"dominatrix.register": async (p) => {
  const client: ChromeClient = {
    id: p.instanceId,          // ← Key: instanceId from Chrome
    profileName: p.profileName,
    extensionId: p.extensionId,
    registeredAt: Date.now(),
  };
  clients.set(client.id, client);  // ← Added to Map, never removed!
};
```

---

## Bug: Client Connection Leak

### The Problem

The dominatrix extension's `clients` Map grows unbounded because **clients are registered but never unregistered**.

### How Clients Accumulate

**Cause 1: Chrome Service Worker Restarts**

Chrome kills idle service workers after ~30 seconds of inactivity. On restart:

```
1. Service worker killed by Chrome
2. Service worker restarts (any event triggers this)
3. new DominatrixBackground() → NEW instanceId (crypto.randomUUID())
4. Connects to gateway → registers with new instanceId
5. Old instanceId still in dominatrix clients Map ← LEAKED
```

Over hours/overnight, this accumulates dozens of stale client entries.

**Cause 2: Gateway/Extension Host Restart + Reconnect Race**

```
1. Gateway restarts (watchdog or HMR)
2. Extension host respawns → clients Map is fresh (empty)
3. Chrome extension WS disconnects → reconnects after 3s
4. Re-registers with same instanceId → OK, single entry
```

This case actually works fine because the extension host restart clears the Map. But combined with Cause 1, it doesn't help.

**Cause 3: Extension Host HMR Without Chrome Re-register**

```
1. Extension host HMR reloads (file change in extensions/dominatrix/)
2. dispose() → clients.clear()
3. Extension re-registers with gateway
4. Chrome extension's WS is still alive (connected to gateway, not ext host)
5. Chrome extension does NOT re-register (only registers on ws.onopen)
6. clients Map is now empty — commands fail: "No Chrome extension clients"
```

### Why There's No Cleanup

The gateway knows when a WebSocket client disconnects (`close` handler in index.ts), but there's no mechanism to notify the dominatrix extension that one of its registered Chrome clients dropped.

The disconnect happens at two different layers:

- **Gateway layer**: WebSocket close → removes from gateway `clients` Map, cleans up voice streams
- **Extension layer**: dominatrix `clients` Map → **nothing happens**

These two layers are completely decoupled — the gateway doesn't know which WS connections are Chrome extension clients vs regular web UI clients.

### Fix Options

**Option A: Heartbeat-Based Cleanup (simplest)**

Add a periodic sweep in the dominatrix extension that pings registered clients:

```typescript
// Every 30s, emit a heartbeat event
// Chrome extensions that are alive respond via dominatrix.heartbeat_response
// Clients that don't respond within 10s get pruned
setInterval(() => {
  for (const [id, client] of clients) {
    if (Date.now() - client.lastSeen > 60_000) {
      clients.delete(id);
    }
  }
}, 30_000);
```

Chrome extension sends periodic heartbeats or responds to pings to update `lastSeen`.

**Option B: Gateway Disconnect Notification (architectural)**

When the gateway's WebSocket close handler fires, check if the disconnecting client was subscribed to `dominatrix.command` and notify the extension:

```typescript
// In gateway close handler:
close(ws) {
  clients.delete(ws);

  // Notify extensions about client disconnect
  if (ws.data.subscriptions.has("dominatrix.command")) {
    extensions.broadcast({
      type: "client.disconnected",
      payload: { connectionId: ws.data.id },
    });
  }
}
```

The dominatrix extension would need to track `connectionId → instanceId` mapping to know which client to remove.

**Option C: Re-register on Any Reconnect (Chrome-side fix)**

Store `instanceId` in `chrome.storage.local` so it survives service worker restarts, and always re-register with the same ID:

```typescript
// In background.ts constructor:
const stored = await chrome.storage.local.get("instanceId");
this.instanceId = stored.instanceId || crypto.randomUUID();
await chrome.storage.local.set({ instanceId: this.instanceId });
```

This prevents Cause 1 (new UUIDs on restart) since re-registering with the same ID overwrites the Map entry. Stale entries from truly dead clients would still need cleanup via Option A or B.

### Recommended: Option C + Option A

- **Option C** eliminates the main source of leaks (service worker restarts generating new UUIDs)
- **Option A** (simple heartbeat/TTL) catches any remaining edge cases

---

## Health Check

Mission Control queries `dominatrix.health_check` which returns:

```typescript
{
  ok: boolean,              // true if any clients connected
  status: "healthy" | "disconnected",
  label: "Browser Control (DOMINATRIX)",
  metrics: [
    { label: "Connected Clients", value: N },  // ← inflated by leak
    { label: "Pending Commands", value: N },
  ],
  items: [                  // ← one entry per registered client
    {
      id: "instance-uuid",
      label: "user@gmail.com",
      status: "healthy",    // ← always "healthy", no liveness check
      details: { registered: "2026-02-16T..." }
    }
  ]
}
```

Note: `status: "healthy"` is hardcoded for all clients — there's no actual liveness check. A stale client entry looks identical to a live one in Mission Control.

---

## Tab, Session & Profile Routing

Three questions have to be answered before any command can run: **which profile**,
**which tab**, and **who is asking**. The answers come from `dispatch()` in the
gateway extension and `resolveTabId()` in the Chrome background worker.

### Which profile: explicit addressing

Every Chrome profile runs its own extension instance with its own `instanceId`, and
all of them subscribe to `dominatrix.command` non-exclusively. What makes exactly one
of them act is the `targetInstanceId` on the command payload:

```
dispatch() → pickClient() → sendCommand(action, params, targetInstanceId)
  → ctx.emit("dominatrix.command", { requestId, action, params, targetInstanceId })
    → every Chrome client receives it
      → each drops it unless targetInstanceId === its own instanceId
```

`pickClient()` resolves the profile in this order:

1. **`--profile <label|id>`** — explicit wins. Matched against the profile's
   signed-in email or its instance ID, exact first then prefix/substring.
2. **The session's bound profile** — if this session is already working in a tab,
   commands stay in that profile.
3. **The only connected profile** — no ambiguity to resolve.
4. **Refuse, or fall back**: `navigate` and `new_tab` throw an error listing the
   connected profiles rather than guessing, because opening a tab in the wrong
   profile isn't something the caller can undo. Every other command falls back to
   the most recently focused profile.

Focus is reported by re-registering with `focused: true` on
`chrome.windows.onFocusChanged`; the gateway keeps it as `lastFocusedAt`. It is only
a tiebreaker for reads now, not a routing mechanism.

> **Why not exclusive subscriptions?** An earlier design had each profile re-subscribe
> with `exclusive: true` on focus, so the last-focused profile received every command.
> It routed by a global side effect: any window click anywhere silently re-pointed an
> unrelated session's commands at a different browser. Addressing each command to one
> instance makes the target a property of the command instead.

### Which tab: session bindings

Commands declare `sessionId` in their schema, so the CLI auto-injects
`$ANIMA_SESSION_ID`. The gateway extension keeps a per-session binding:

```typescript
interface SessionBinding {
  instanceId: string; // profile the tab lives in
  tabId: number; // the tab the session is working in
  recent: number[]; // MRU of tabs this session has driven
  updatedAt: number;
}
```

Bindings persist through `ctx.store`, so a gateway restart doesn't lose the tab a
long-running session is in the middle of.

A command with no `--tabId` reuses the session's bound tab, as long as that tab lives
in the profile that was picked. Binding happens only on acts that _choose_ a tab —
`navigate`, `new_tab`, `use_tab`, or an explicit numeric `--tabId`. A bare
`get_title` deliberately does **not** pin the session, so "what am I looking at?"
keeps following the user's real active tab.

### Tab selectors

`--tabId` accepts a number or one of two sentinels:

| Value       | Resolution                                                      |
| ----------- | --------------------------------------------------------------- |
| _(omitted)_ | Session's bound tab → side panel context → active tab           |
| `new`       | `chrome.tabs.create()`; only `navigate` and `new_tab` accept it |
| `active`    | The profile's focused tab, bypassing a stale side-panel context |
| `<number>`  | That tab, and the session binds to it                           |

`new` survives the CLI intact because the schema is a `z.union([z.number(),
z.enum(["new", "active"])])` — it lands as `anyOf` in JSON Schema, and the CLI's
coercion leaves non-numeric text as a string.

### Getting back to a tab

`session_tabs` lists the session's MRU with live titles and URLs, pruning tabs that
have been closed and marking the current one. `use_tab --tabId <id>` re-binds the
session to one of them and focuses it.

### Known sharp edge: side panel context is per-window

Chrome's side panel API is window-scoped. `sidepanel.ts` reports the active tab on
open and on every `chrome.tabs.onActivated`, and the background worker keeps it as
`contextTabId`. It is never cleared, so with no session binding and no `--tabId` a
long-open side panel can still point at a tab in a different window than the one in
front. `--tabId active` overrides it; a session binding takes precedence over it.

### `chrome.tabs.query` in service workers

`chrome.tabs.query({ active: true, currentWindow: true })` behaves differently in a
service worker than in a page context: `currentWindow` means the **last focused
window** rather than the window containing the caller. Since the background worker
handles commands, `getActiveTab()` returns the active tab of whichever window Chrome
last considered current — another reason a session binding beats "the active tab".

### Client cleanup

The gateway prunes stale WebSocket connections via ping/pong and emits
`client.disconnected`; the extension maps `connectionId → instanceId` and drops the
client, so Mission Control's health check doesn't accumulate ghost profiles.
