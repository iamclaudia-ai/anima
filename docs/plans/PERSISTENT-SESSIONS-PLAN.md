# Persistent Sessions & Extension Storage

## Problem

Extensions like iMessage and Voice Mode need long-running sessions that survive gateway restarts. Currently they store `sessionId` in memory, which is lost on restart. When a message arrives after restart, the extension tries to use a stale sessionId and fails.

## Design

### 1. Extension Store (`ctx.store`)

Each extension gets persistent key-value storage at `~/.anima/<extension-id>/store.json`.

Provided by the extension-host automatically — no setup required.

```typescript
// Simple get/set
ctx.store.get("lastRowId"); // → number | null
ctx.store.set("lastRowId", 42); // → persists immediately

// Dot notation for nested props
ctx.store.set("session.id", "abc");
ctx.store.set("session.rotatedAt", "2026-03-21");
ctx.store.get("session.id"); // → "abc"
ctx.store.get("session"); // → { id: "abc", rotatedAt: "2026-03-21" }

// Delete
ctx.store.delete("session.id");

// Backed by: ~/.anima/imessage/store.json
```

**Implementation notes:**

- Read file on extension start, write on every `set`/`delete`
- Use `Bun.write` with atomic semantics (write to tmp + rename)
- No locking needed — single process per extension

### 2. Persistent Session Sentinel

A well-known constant that tells the session extension: "resolve the real sessionId for me."

```typescript
// packages/shared/src/constants.ts
export const PERSISTENT_SESSION_ID = "00000000-0000-0000-0000-000000000000";
```

**Schema:** No changes needed — `sessionId` is `z.string()`, not `z.string().uuid()`.

### 3. Session Extension: Persistent Session Resolution

When `session.send_prompt` receives `PERSISTENT_SESSION_ID`, the session extension:

1. **Resolves** the real sessionId using `cwd` + `source` as the lookup key
2. **Creates** a new session if none exists for that combo
3. **Recovers** if the resolved session is stale/dead (create new, update mapping)
4. **Rotates** if the rotation policy triggers (configurable)
5. **Persists** the mapping in the session DB (survives restarts)

```typescript
// In session extension's send_prompt handler:
case "session.send_prompt": {
  let sessionId = params.sessionId as string;

  if (sessionId === PERSISTENT_SESSION_ID) {
    const cwd = params.cwd as string;
    const source = params.source as string | undefined;
    if (!cwd) throw new Error("cwd is required for persistent sessions");
    sessionId = await resolvePersistentSession(cwd, source);
  }

  // ... rest of send_prompt logic unchanged
}
```

**Persistent session DB table:**

```sql
CREATE TABLE persistent_sessions (
  cwd       TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT '',
  sessionId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  messageCount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cwd, source)
);
```

**`resolvePersistentSession(cwd, source)`:**

```
1. SELECT sessionId FROM persistent_sessions WHERE cwd = ? AND source = ?
2. If found:
   a. Check if session is alive (in agent-host active list)
   b. If alive → return sessionId
   c. If dead → create new session, UPDATE row, return new sessionId
   d. If rotation policy triggers → close old, create new, UPDATE row
3. If not found:
   a. get_or_create_workspace(cwd)
   b. create_session(cwd)
   c. INSERT into persistent_sessions
   d. Return new sessionId
```

### 4. Rotation Policy

Configurable per-extension in `anima.json`:

```json
{
  "imessage": {
    "enabled": true,
    "config": {
      "workspaceCwd": "/Users/claudia/chat",
      "sessionRotation": {
        "maxMessages": 200,
        "maxAgeHours": 24
      }
    }
  }
}
```

When a persistent session exceeds `maxMessages` or `maxAgeHours`, the session extension:

1. Closes the old session gracefully
2. Creates a fresh session
3. Updates the persistent_sessions mapping
4. Injects memory context into the new session (same as create_session does today)

### 5. Caller Simplification

**iMessage (before):**

```typescript
let currentSessionId: string | null = null;

async function ensureSession(cwd) { ... }

async function handleMessage(message) {
  if (!currentSessionId) await ensureSession(cwd);
  try {
    result = await ctx.call("session.send_prompt", { sessionId: currentSessionId, ... });
  } catch (err) {
    if (err.includes("not found")) {
      currentSessionId = null;
      await ensureSession(cwd);
      result = await ctx.call("session.send_prompt", { sessionId: currentSessionId, ... });
    }
  }
}
```

**iMessage (after):**

```typescript
import { PERSISTENT_SESSION_ID } from "@anima/shared";

async function handleMessage(message) {
  const result = await ctx.call("session.send_prompt", {
    sessionId: PERSISTENT_SESSION_ID,
    content,
    cwd: cfg.workspaceCwd,
    source: buildSource(message.chat_id),
  });
}
```

**Voice Mode iOS (after):**

```swift
let params: [String: Any] = [
    "sessionId": "00000000-0000-0000-0000-000000000000",
    "content": transcribedText,
    "cwd": settings.workspaceCwd,  // from settings screen
    "source": "voicemode",
]
gateway.send(method: "session.send_prompt", params: params)
```

## Implementation Order

1. **Extension Store** — Add `ctx.store` to extension-host (`packages/extension-host/`)
2. **Sentinel Constant** — Add `PERSISTENT_SESSION_ID` to `packages/shared/`
3. **Persistent Session Table** — Add migration + resolver to session extension
4. **Wire into send_prompt** — Detect sentinel, resolve, recover, rotate
5. **Simplify iMessage** — Remove all session management, use sentinel
6. **Update EXTENSIONS.md** — Document store API and "never store state in memory alone"
7. **iOS Voice Mode** — Add settings screen, update gateway URL + cwd
8. **General workspace flag** — Future: memory injection across all conversations

## Update EXTENSIONS.md

Add section:

> ### Extension Storage
>
> Every extension has persistent storage at `~/.anima/<extension-id>/store.json`,
> accessible via `ctx.store`. Use this for any state that must survive restarts.
>
> **Rule: Never store state in memory alone.** Gateway and extension restarts
> happen regularly. Any state stored only in a variable will be lost. Use
> `ctx.store` for persistence, and treat in-memory state as a cache of what's
> on disk.
>
> ### Persistent Sessions
>
> Extensions that need long-running sessions (iMessage, Voice Mode) should use
> the `PERSISTENT_SESSION_ID` sentinel instead of managing sessions themselves.
> The session extension handles creation, recovery, rotation, and persistence.
