# Extension Runtime System

Date: 2026-04-02

## Purpose

This document describes the current Anima extension runtime after the actor-runtime stabilization work.

The important outcome is:

- no single long-running extension request should block unrelated control or read traffic
- `session`, `memory`, and `voice` now run on one shared container model
- the concurrency fix lives in `packages/extension-host`, not in the pipe transport itself

## The Original Failure

The original issue was not stdin/stdout pipes.

The real problem was that the extension host admitted most inbound work through one serialized regular lane. That meant:

- one stuck request blocked later requests from even starting
- health checks were delayed behind business work
- `memory.health_check` timed out behind memory processing
- `session.list_workspaces` timed out behind `session.send_prompt`

The key design mistake was coupling:

- request delivery
- request execution
- request completion

## What Changed

### 1. Extension Host Scheduling

The main platform change is in [index.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/extension-host/src/index.ts) and [request-scheduler.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/extension-host/src/request-scheduler.ts).

The extension host now:

- keeps draining inbound frames instead of waiting for one request to finish before admitting the next
- routes requests through a `RequestScheduler`
- supports method execution metadata from `@anima/shared`
- supports shared lanes:
  - `control`
  - `read`
  - `write`
  - `long_running`
  - `stream`
- supports concurrency modes:
  - `parallel`
  - `serial`
  - `keyed`

That means unrelated work can run concurrently while still serializing the specific resource that actually needs exclusivity.

Examples:

- `session.list_workspaces` runs on `read + parallel`
- `session.send_prompt` runs on `long_running + keyed(sessionId)`
- `voice.speak` runs on `long_running + keyed(connectionId)`
- `memory.health_check` runs on `control + parallel`

Keyed execution now supports either:

- `keyParam`
- `keyContext`

That matters for extensions like `voice`, where exclusivity is tied to the request envelope `connectionId` rather than a method parameter.

### 2. Request Context Isolation

The extension host now uses `AsyncLocalStorage` for request envelope context.

That matters because once multiple requests can be in flight, ambient mutable globals for:

- `connectionId`
- `tags`
- `traceId`

would corrupt each other.

The current model keeps that context request-scoped so concurrent work does not bleed metadata.

### 3. Standard Extension Runtime Container

The shared helper in [standard-extension.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/extension-host/src/standard-extension.ts) now supports a runtime container model.

Extensions can provide:

- `createRuntime(ctx, config)`
- `start(instance)`
- `stop(instance)`
- `health(instance)`
- `handleSourceResponse(source, event, instance)`

Method handlers now receive:

```ts
{
  (ctx, runtime, config);
}
```

instead of only raw `ctx`.

This is the common shape new extensions should use.

## Current Runtime Model

Treat each extension process as a small actor container.

At the shared runtime level:

- the extension process is the container
- the extension host is the scheduler and envelope manager
- the runtime container holds the extension's shared services
- methods are routed with lane and concurrency metadata

At the extension level:

- the runtime container owns shared services
- smaller actor-like services own stateful domains
- only resource-local work is serialized

## Session Architecture

The session extension is the most important interactive example.

Key files:

- [index.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/index.ts)
- [runtime.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/runtime.ts)
- [session-actor-registry.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-actor-registry.ts)
- [session-agent-bridge.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-agent-bridge.ts)
- [session-registry.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-registry.ts)
- [session-methods.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-methods.ts)

Session now has three important service boundaries:

- `sessionActors`
  per-session prompt state, accumulated text, turn completion, routing metadata
- `bridge`
  all transport to `agent-host`
- `registry`
  workspace/session/task metadata persistence

Why this matters:

- prompt state is no longer stored in loose extension-wide maps
- multiple Claude sessions can progress concurrently
- read methods no longer wait behind a prompt from another session

## Memory Architecture

The memory extension is the main background-pipeline example.

Key files:

- [index.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/memory/src/index.ts)
- [scheduler.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/memory/src/scheduler.ts)
- [repo-sync.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/memory/src/repo-sync.ts)
- [state-machine.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/memory/src/state-machine.ts)

The important splits are:

- scheduler progression is no longer tied to gateway heartbeat for business logic
- repo sync is no longer on the same critical path as Libby processing
- the extension now runs on the same shared runtime container helper as session
- liveness ownership is now gateway-managed through runtime locks, not a memory-private lock table

Memory now uses gateway-owned liveness locks for recovery-relevant ownership:

- memory acquires and renews a gateway runtime lock through `ctx.call("gateway.acquire_liveness_lock")`
- gateway exposes runtime lock state in `/health` as `runtimeLocks`
- watchdog consumes that gateway-reported state instead of inspecting memory tables directly
- recovery for a stale memory singleton now goes through `gateway.restart_extension("memory")` when gateway itself is healthy

Memory still has a large single file, but the runtime model is now aligned with the shared platform.

This is the intended ownership split:

- `extension-host`
  scheduling, lanes, keyed concurrency, request context isolation
- `gateway`
  durable liveness locks and extension restart control
- `memory`
  ingest, scheduling, processing, repo sync, and any fine-grained internal coordination that does not affect system-wide recovery

## Voice Architecture

Voice is the main per-connection streaming example.

Key files:

- [index.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/voice/src/index.ts)
- [index.test.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/voice/src/index.test.ts)

The important splits are:

- `VoiceConnectionManager` owns per-connection stream state
- startup and shutdown now go through the shared runtime container helper
- method execution is keyed by request `connectionId` where appropriate
- session event subscriptions are cleaned up through runtime-owned unsubscribers

Why this matters:

- one browser connection can stop or speak without serializing unrelated browser connections
- voice state is no longer stored in loose extension-wide globals
- the session event pipeline and browser audio pipeline now use the same runtime conventions as `session` and `memory`

## Agent-Host Boundary

### Did `agent-host` need changes?

Not for this stabilization pass.

The concurrency failure was in `packages/extension-host`, where process-based extensions were being overserialized.

`packages/agent-host` already has a different role:

- it is a WebSocket server
- it routes request/response messages for session and task operations
- it broadcasts buffered `session.event` and `task.event` messages to subscribed clients

Relevant files:

- [server.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/agent-host/src/server.ts)
- [session-host.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/agent-host/src/session-host.ts)

What changed around `agent-host` was on the session-extension side:

- [agent-client.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/agent-client.ts) already handled request correlation over WebSocket
- [session-agent-bridge.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-agent-bridge.ts) was added to make that transport a clear runtime service boundary

So:

- no architectural redesign of `packages/agent-host` was required
- the main fix was making the extension host stop blocking unrelated work
- session needed a cleaner bridge to `agent-host`, not a new `agent-host` protocol

## Why Pipes Were Not the Problem

This is worth stating directly.

The stdin/stdout process transport was not the root issue.

If the host had continued to serialize all inbound requests on one queue, the same traffic jam would have happened over:

- WebSockets
- TCP
- in-memory channels
- any other transport

The fix was scheduling and resource isolation.

## Current Migration Status

Fully migrated to the shared runtime container helper:

- `session`
- `memory`
- `voice`

Still on the older direct `AnimaExtension` shape:

- `chat`
- `control`
- `hooks`
- `scheduler`
- `imessage`
- `disco`
- `presenter`
- `testroute`
- `audiobooks`
- `dominatrix`

Some of those are low-risk to leave alone for now, but not all of them.

## Tricky Remaining Extensions

### iMessage

iMessage is also not simple.

It has:

- a long-lived RPC client
- source-aware reply routing into session
- startup catchup behavior
- background subscription handling

This should migrate to the standard container helper, but it will need a clear split between:

- transport/client service
- catchup/message workflow
- method handlers

### Hooks

Hooks looks small, but it is operationally subtle.

It has:

- dynamic module loading
- global and workspace hook overlays
- wildcard event subscription
- internal precedence rules

It should eventually use the standard container helper, but the bigger concern is keeping event dispatch semantics stable.

### Scheduler

Scheduler is already actor-like internally.

It has:

- durable state
- its own loop
- execution history
- concurrency policy per task

It is a good candidate for migration to the runtime container helper, but the internal scheduling model is already specialized and should not be flattened into generic method handlers.

## Recommended Rules For New Extensions

1. Default to `createStandardExtension()` with `createRuntime()`.
2. Declare `execution` metadata on every method.
3. Put health and lightweight status on `control + parallel`.
4. Put cheap reads on `read + parallel`.
5. Only use `serial` or `keyed` where a real resource requires it.
6. Put long-running work on `long_running`.
7. If the extension maintains long-lived connections, watchers, or background loops, hide them behind services in the runtime container.
8. Avoid loose extension-wide mutable maps when a smaller keyed service can own the state.

## What Is Still Left

The system is materially more stable now, but the migration is not finished.

Remaining platform work:

- migrate more extensions onto the runtime container helper
- document actor/container conventions for new extension authors
- reduce very large custom extension files, especially `memory` and `voice`
- standardize source-routing and event-subscription patterns where helpful

The most important stabilization work is already in place because the problematic paths, `session`, `memory`, and `voice`, are now on the shared model.
