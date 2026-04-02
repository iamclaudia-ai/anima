# Extension Actor Architecture Plan

Date saved: 2026-04-02

## Goal

Stabilize the gateway/extension runtime so that no single stuck request, task, or background job can block unrelated work.

The platform should support:

- one gateway
- one session extension
- one agent host connection
- many concurrent Claude sessions
- background actors like Libby running without blocking session reads or control traffic
- extension authors using simple helpers that hide reply correlation and transport plumbing

This plan generalizes the existing memory actor work into a shared runtime model for all extensions.

## Root Problem

The current system uses an asynchronous transport, but still behaves too much like a synchronous RPC stack.

Today the transport is not the primary issue:

- stdin/stdout pipes can carry multiple messages just fine
- WebSockets would have the same failure mode if scheduled the same way

The real issue is that delivery, execution, and response are too tightly coupled.

Current failure pattern:

1. gateway sends request to extension host
2. extension host reads the inbound frame
3. extension host serializes most normal requests on a shared regular lane
4. a long-running handler keeps that lane occupied
5. unrelated requests wait behind it and time out before they even begin

This is why:

- `memory.health_check` was blocked by memory processing
- `session.list_workspaces` was blocked by `session.send_prompt`

The design bug is not "pipes" or "awaiting a write". The design bug is "awaiting completion of one request before admitting unrelated work".

## Design Principles

1. Transport must be fully asynchronous and continuously draining.
2. Request delivery must be decoupled from request completion.
3. Replies are correlated messages, not shared call stacks.
4. Only the resource that truly requires serialization should be serialized.
5. Control-plane work must bypass long-running data-plane work.
6. Extension authors should not manually manage callback plumbing.
7. The runtime should expose simple helpers, while internally behaving like an actor system.

## Runtime Model

Treat each extension process as an actor system, not as one global mailbox.

### Wire Protocol

All cross-process communication should be message-based:

- `command`
  fire-and-forget, no reply expected
- `request`
  expects one correlated reply
- `response`
  correlated completion for a prior request
- `event`
  broadcast or stream message

Conceptual frame shape:

```ts
type Frame =
  | { type: "command"; method: string; payload: unknown; messageId: string; meta?: Meta }
  | { type: "request"; method: string; payload: unknown; requestId: string; meta?: Meta }
  | { type: "response"; requestId: string; ok: true; result: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "event"; event: string; payload: unknown; meta?: Meta };
```

### Runtime API

Expose simple helpers that hide request correlation:

- `ctx.send(method, payload, meta?)`
- `ctx.request<T>(method, payload, meta?)`
- `ctx.emit(event, payload, meta?)`
- `ctx.subscribe(pattern, handler)`

Important:

- `request()` should internally allocate a `requestId`, store a pending resolver, and resolve when a matching `response` arrives
- extension authors should not manually pass reply recipients or callbacks around

## Actor Model

Do not model one extension as one actor.

Use:

- extension process = actor runtime
- one or more actors inside the extension
- messages routed to the appropriate actor

This avoids recreating the current bottleneck at a slightly different layer.

### Actor Responsibilities

Each actor should own:

- a bounded state domain
- a mailbox
- a concurrency rule
- optional resource keying

Examples:

- `SessionReadActor`
- `PromptActor(sessionId)`
- `MemorySchedulerActor`
- `MemoryRepoSyncActor`
- `VoiceStreamActor`

## Scheduling Model

The runtime should support both lanes and keyed serialization.

### Lanes

Shared lane types:

1. `control`

- health checks
- liveness
- diagnostics
- lightweight metadata

2. `read`

- cheap DB reads
- filesystem reads
- workspace/session listing

3. `write`

- short mutations
- metadata updates
- state transitions

4. `long_running`

- prompts
- LLM calls
- background processing
- sync jobs

5. `stream`

- token streams
- incremental UI updates
- event fanout

### Concurrency Modes

Each actor or method should declare one of:

- `parallel`
- `serial`
- `keyed`

`keyed` means:

- only one message per key runs at a time
- different keys may run concurrently

Examples:

- `session.send_prompt` keyed by Claude `sessionId`
- `memory.process_conversation` keyed by singleton processing lease
- `voice` stream work keyed by stream/session id

## Why This Fixes The Traffic Jam

Under this model:

- `session.list_workspaces` runs on a read lane
- `session.send_prompt` runs on a long-running lane keyed by `sessionId`
- both can be active at the same time
- the host keeps reading frames continuously
- responses resolve pending promises independently

That means:

- a long prompt does not block workspace loading
- a background memory sync does not block session reads
- health checks remain responsive

## Extension Categories

Most current extensions fit a small number of architectural categories.

### 1. Control / Read-Heavy

Traits:

- mostly cheap reads
- minimal long-running work
- light event handling

Runtime needs:

- fast parallel read lane
- control bypass
- little or no keyed serialization

Examples:

- `control`
- `disco`
- `editor`
- `presenter`
- parts of `chat`

### 2. Stateful Interactive

Traits:

- owns interactive sessions or streams
- long-running work tied to a specific resource
- concurrent across resources, serialized within one resource

Runtime needs:

- keyed long-running lane
- independent read/control actors
- streaming event lane

Examples:

- `session`
- `voice`
- `imessage`

### 3. Background Pipeline

Traits:

- ingest, queueing, processing, retries, sync
- multiple background loops
- explicit state transitions and recovery

Runtime needs:

- multiple internal actors
- durable leases/checkpoints
- decoupled processing and sync

Examples:

- `memory`
- `scheduler`
- parts of `audiobooks`

## Current Extension Fit

### `session`

Best fit: `stateful interactive`

Recommended split:

- `SessionControlActor`
- `SessionReadActor`
- `SessionRegistryActor`
- `PromptActor(sessionId)`
- `AgentHostBridgeActor`

Immediate problem this fixes:

- workspace/session reads blocked behind prompts

### `memory`

Best fit: `background pipeline`

Already moving in this direction:

- `HealthActor`
- `SchedulerActor`
- `ProcessingActor`
- `RepoSyncActor`

Still needed:

- explicit processing lease model
- fuller actor registration on the shared runtime

### `voice`

Best fit: `stateful interactive`

Likely split:

- `VoiceControlActor`
- `VoiceSessionBridgeActor`
- `VoiceStreamActor(sessionId|streamId)`

### `hooks`

Best fit: mostly `control/read-heavy` plus event fanout

Likely split:

- `HooksRegistryActor`
- `HooksDispatchActor`

### `scheduler`

Best fit: `background pipeline`

Likely split:

- `TaskReadActor`
- `TaskExecutionActor(taskId or queue key)`
- `WebhookActor`

### `imessage`

Best fit: `stateful interactive`

Likely split:

- `IMControlActor`
- `IMInboundActor(conversation/thread key)`
- `IMSessionBridgeActor`

### `chat`, `control`, `presenter`, `disco`, `editor`

Best fit: `control/read-heavy`

These likely need only:

- control lane
- parallel read lane
- standard wrapper compatibility at first

### `audiobooks`, `bogart`, `dominatrix`, `testroute`

These need a lighter audit, but they likely fit one of:

- control/read-heavy
- background pipeline

They should stay on the compatibility path until the runtime is stable.

## Platform Responsibilities

The runtime should own:

- frame parsing
- request id generation
- pending response map
- timeout cleanup
- late-response handling
- cancellation propagation
- lane scheduling
- keyed executors
- request-scoped context

The runtime should not expose mutable ambient globals that break under concurrency.

Request context should be either:

- explicit in handler arguments, or
- safely request-scoped via async context

## Extension Author Experience

Extension authors should declare actor structure, not transport plumbing.

Conceptual API:

```ts
registerActor("session.read", {
  lane: "read",
  concurrency: "parallel",
  handlers: {
    "session.list_workspaces": async () => ({ workspaces: listWorkspaces() }),
    "session.get_workspace": async ({ params }) => ({ workspace: getWorkspace(params.id) }),
  },
});

registerActor("session.prompt", {
  lane: "long_running",
  concurrency: "keyed",
  key: ({ params }) => params.sessionId,
  handlers: {
    "session.send_prompt": async ({ params }) => sendPrompt(params),
  },
});
```

Standard wrapper:

```ts
registerStandardExtension({
  handleMethod,
  health,
});
```

That lets simple extensions stay simple while complex ones opt into real actor splits.

## Migration Strategy

### Phase 1. Shared Runtime

Build actor-capable runtime in `packages/extension-host`:

- asynchronous request/response correlation
- lane scheduler
- keyed executors
- request-scoped context
- compatibility wrapper for existing extensions

Do not require immediate extension rewrites.

### Phase 2. Control / Read Bypass

Add host-level method classification:

- control
- read
- write
- long_running

Allow extensions to mark methods, while preserving legacy defaults.

### Phase 3. Session Refactor

Refactor `session` first because it is now the main user-facing bottleneck.

Minimum target:

- `session.list_workspaces`
- `session.list_sessions`
- `session.get_workspace`
- `session.get_directories`
- `session.get_info`

must not block behind:

- `session.send_prompt`
- `session.start_task`

### Phase 4. Memory Migration

Move memory from local actor-ish services onto the shared runtime model.

Keep the existing internal actor boundaries from the memory plan and map them onto host actors.

### Phase 5. Voice / iMessage / Scheduler

Refactor the next stateful/background extensions after session and memory stabilize.

### Phase 6. Audit Remaining Extensions

Keep low-risk extensions on standard wrapper mode until needed.

## Relationship To Memory Plan

This plan is the platform-level generalization of [MEMORY-ACTOR-ARCHITECTURE-PLAN.md](/Users/michael/Projects/iamclaudia-ai/anima/docs/plans/MEMORY-ACTOR-ARCHITECTURE-PLAN.md).

Memory remains the best example of a background pipeline extension. The shared runtime should support memory's actor boundaries directly rather than forcing memory to reinvent scheduling inside one process forever.

## Immediate Priorities

1. Define host/runtime primitives and compatibility wrapper.
2. Refactor `session` into read/control vs prompt actors.
3. Keep `memory` moving toward explicit leases and shared actor registration.
4. Audit `voice` as the next keyed-concurrency extension.

## Success Criteria

The architecture is working when all of the following are true:

- `session.list_workspaces` remains fast during active prompts
- `memory.health_check` remains fast during Libby processing and git sync
- multiple Claude sessions can prompt concurrently
- one blocked actor does not block unrelated actors in the same extension process
- health checks expose actor-level status rather than only process-level status
- extension authors use simple helpers, not manual callback plumbing
