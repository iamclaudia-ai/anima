---
name: anima-extension
description: Create or update an Anima extension using the current extension-host runtime model. Use when adding a new extension, migrating an older extension to createStandardExtension, choosing method lanes/concurrency, wiring events/source routes, or building runtime-container services for stateful extensions like session, memory, voice, hooks, or schedulers.
---

# Anima Extension

Use this skill when building or refactoring an Anima extension.

## Goal

Produce extensions that fit the current platform model:

- hosted by `packages/extension-host`
- scheduled by method lane/concurrency metadata
- implemented with `createStandardExtension()` by default
- using `createRuntime(ctx, config)` for shared services

## Default Approach

For a new extension:

1. Decide the extension category.
2. Use `createStandardExtension()` unless there is a strong reason not to.
3. Add `execution` metadata to every method.
4. Keep request handlers small; move long-lived state into runtime services.
5. Add or update tests for:
   - method behavior
   - lifecycle behavior
   - lane/concurrency behavior if the extension is stateful

## Choose The Extension Shape

### 1. Basic Control / Read-Heavy

Use this for:

- simple dashboards
- filesystem or DB reads
- light utility extensions

Pattern:

- `createStandardExtension()`
- small `createRuntime()`, often empty
- mostly `read + parallel`
- health on `control + parallel`

See [basic-extension.md](references/basic-extension.md).

### 2. Stateful Interactive

Use this for:

- per-session work
- per-connection work
- bridges to other long-lived services
- source-routed or event-driven extensions

Pattern:

- `createStandardExtension()`
- `createRuntime()` builds shared services
- keyed state owned by a runtime service, not loose globals
- use `keyed` concurrency only for the resource that needs serialization

See [advanced-extension.md](references/advanced-extension.md).

### 3. Background Pipeline

Use this for:

- watchers
- schedulers
- queue processors
- sync loops

Pattern:

- runtime container owns loop services
- methods mostly inspect or trigger the pipeline
- health exposes per-lane/per-service diagnostics
- do not put long-running loops directly inside method handlers

Use `memory` as the main reference in the codebase.

## Method Execution Rules

Every method should declare `execution`.

Use:

- `control + parallel`
  health checks, diagnostics, liveness
- `read + parallel`
  cheap reads
- `write + serial`
  short shared mutations
- `long_running + keyed`
  long work tied to a specific resource
- `stream`
  only when the extension truly owns streaming semantics

Do not serialize the whole extension unless the resource truly requires it.

## Runtime Container Rules

Use `createRuntime(ctx, config)` to build shared services once.

Good runtime members:

- clients
- registries
- actor-like keyed state managers
- watchers
- schedulers
- unsubscribers

Bad runtime members:

- arbitrary mutable state that should belong to a keyed resource owner

Prefer small service objects such as:

- `bridge`
- `registry`
- `connectionManager`
- `scheduler`

## Event Subscription Rules

When subscribing to gateway events:

- subscribe in `start(instance)`
- clean up in `stop(instance)`
- keep unsubscribe functions in runtime
- avoid overlapping wildcard and exact subscriptions unless you deliberately want duplicate handling

If the extension reacts only for a specific connection/session/source, route that through keyed runtime state instead of global conditionals scattered across handlers.

## Source Routes

If the extension handles source replies:

- declare `sourceRoutes`
- implement `handleSourceResponse(source, event, instance)`
- keep source routing logic in a small runtime service when it gets stateful

## Agent-Host Guidance

If the extension talks to `packages/agent-host`:

- keep transport details behind a bridge service
- do not scatter `WebSocket` or low-level request plumbing across handlers
- use the session extension's bridge pattern as the reference

## Testing

Always add or update tests.

Minimum expectations:

- method success/failure cases
- start/stop lifecycle
- health check

For stateful extensions also test:

- concurrent reads vs long-running work
- keyed isolation across different sessions/connections
- cleanup of event subscriptions or background loops

## References

- Basic example: [basic-extension.md](references/basic-extension.md)
- Advanced example: [advanced-extension.md](references/advanced-extension.md)
- Shared helper: [standard-extension.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/extension-host/src/standard-extension.ts)
- Runtime architecture: [EXTENSION-RUNTIME-SYSTEM.md](/Users/michael/Projects/iamclaudia-ai/anima/docs/architecture/EXTENSION-RUNTIME-SYSTEM.md)
