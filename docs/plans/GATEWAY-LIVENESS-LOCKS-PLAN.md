# Gateway Liveness Locks Plan

Date: 2026-04-05

## Problem Summary

Anima currently has two different lock stories:

1. Gateway-managed extension process locks
   - `extension_process_locks`
   - owned by gateway
   - used to ensure one gateway instance owns a hosted extension process

2. Extension-specific runtime locks
   - for example `memory_extension_locks`
   - owned and interpreted by the extension itself
   - currently inspected by watchdog for memory recovery

That split worked initially, but it has now created an architectural problem:

- watchdog is reaching into memory-specific tables
- recovery policy is coupled to memory internals
- the layer that can restart individual extensions, gateway, is not the canonical source of extension liveness locks

This is the wrong direction.

## Goals

1. Move liveness/recovery-relevant locks to gateway ownership.
2. Keep watchdog as decoupled as possible from extension-specific implementation details.
3. Let gateway report stale lock state and restart the affected extension directly.
4. Preserve extension-specific meaning for locks without forcing watchdog to understand extension tables.
5. Keep the abstraction narrow enough that only real liveness/recovery locks move to gateway.

## Non-Goals

1. Do not move every extension-local advisory lock into gateway.
2. Do not make gateway a generic distributed lock service for arbitrary application logic.
3. Do not remove extension-host scheduling/keyed execution. That is a different concern from durable runtime leases.

## Current State

### Gateway already manages process locks

Gateway already owns `extension_process_locks` in:

- [extension-locks.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/gateway/src/db/extension-locks.ts)

Those locks support:

- acquire
- renew
- release
- stale detection
- stale takeover

Gateway also reports them from `/health` in:

- [index.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/gateway/src/index.ts#L706)

### Memory separately manages a singleton lock

Memory currently owns:

- `memory_extension_locks`
- `memory_file_locks`

in:

- [db.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/memory/src/db.ts)

This is why watchdog had to become memory-aware.

## Recommendation

Create a gateway-owned **liveness lock registry** for hosted extensions.

This registry should own only the lock classes that matter for:

- extension liveness
- recovery policy
- operator observability
- restart decisions

Examples:

- extension singleton lease
- processing lease
- long-running background worker lease

Extension-local fine-grained locks can stay local unless they become recovery-relevant.

## Lock Taxonomy

### 1. Gateway-managed liveness locks

These are durable and operator-visible.

Examples:

- `singleton`
  One active owner for an extension runtime role.
- `processing`
  One active owner for a background processor.
- `lease`
  A renewable unit of exclusive work that affects recovery.

Gateway owns:

- acquisition
- renewal
- release
- stale detection
- reporting
- startup cleanup / takeover rules

### 2. Extension-local advisory locks

These are implementation details inside an extension.

Examples:

- short-lived file ingest coordination
- internal work de-duplication
- local row-level or file-level advisory markers

Extensions own:

- semantics
- lifecycle
- cleanup

These should not be read directly by watchdog.

## Proposed Gateway Model

Introduce a generalized table for extension liveness locks, for example:

- `extension_runtime_locks`

Suggested shape:

```sql
extension_id TEXT NOT NULL,
lock_type TEXT NOT NULL,
resource_key TEXT NOT NULL DEFAULT '__default__',
owner_pid INTEGER NOT NULL,
owner_instance_id TEXT NOT NULL,
owner_generation TEXT,
lease_policy TEXT,
acquired_at INTEGER NOT NULL,
updated_at INTEGER NOT NULL,
metadata_json TEXT,
PRIMARY KEY (extension_id, lock_type, resource_key)
```

Where:

- `extension_id`
  `memory`, `session`, `voice`, etc.
- `lock_type`
  finite set like `singleton`, `processing`, `lease`
- `resource_key`
  lets a lock be singleton-like or keyed
- `lease_policy`
  optional hint for gateway/watchdog
- `metadata_json`
  extension-supplied structured context for UI and logs

## Extension Registration Hook

Extensions should be able to declare which gateway-managed liveness locks they use.

This should be part of extension registration metadata, not hidden inside watchdog logic.

Suggested direction:

```ts
type ExtensionLivenessLockDefinition = {
  type: "singleton" | "processing" | "lease";
  resourceKey?: "default" | "sessionId" | "conversationId" | "custom";
  staleAfterMs: number;
  recovery: {
    action: "restart_extension" | "restart_gateway" | "report_only";
  };
};
```

The important point is not the exact API.
The important point is:

- extension defines policy
- gateway stores and reports state
- watchdog consumes gateway state

## Memory Migration

### Move first

Move these first:

1. Memory singleton liveness lock
   This is the clearest recovery signal and should become gateway-owned.

2. Memory processing lease
   Only if we want watchdog/operator visibility into stuck processing ownership.

### Leave for later

Keep these extension-local for now:

- `memory_file_locks`

Reason:

- they are more implementation-specific
- they do not need to drive watchdog policy yet

## Watchdog Model After Migration

Watchdog should stop reading memory tables directly.

Instead it should:

1. Check gateway health.
2. Read gateway-reported extension liveness lock state.
3. Apply extension-declared policy.
4. Prefer `gateway.restart_extension` when gateway is healthy and only one extension is impaired.
5. Restart gateway only when gateway itself is degraded or unreachable.

This keeps watchdog focused on:

- system liveness
- policy execution
- recovery journaling

and not on extension internals.

## Recovery Responsibility

### Question: who clears locks when watchdog restarts things?

There are two different answers:

#### Current system

- gateway process locks:
  gateway owns stale takeover and release
- memory singleton lock:
  memory owns acquire/renew/release and startup stale takeover
- force-startup path:
  gateway can hard-clear lock tables in [start.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/gateway/src/start.ts#L109) when explicitly requested

So today lock cleanup responsibility is split.

#### Proposed system

For gateway-managed liveness locks:

- gateway is responsible for stale detection
- gateway is responsible for takeover or cleanup on startup
- watchdog is responsible only for deciding when recovery should happen

This is the cleaner layering.

## Recovery Process Recommendation

For gateway-managed liveness locks, the process should be:

1. Normal runtime
   - extension acquires lock through gateway
   - extension renews lease through gateway
   - extension releases lock through gateway on clean shutdown

2. Crash / wedge
   - lease stops renewing
   - gateway reports lock as stale

3. Watchdog recovery
   - if gateway is healthy:
     use `gateway.restart_extension`
   - if gateway is unhealthy/unreachable:
     restart gateway

4. Startup / restart
   - gateway examines existing liveness locks
   - if stale and restart policy allows takeover:
     gateway steals or clears them as part of startup
   - extension then reacquires clean ownership

This means:

- stale locks are not eagerly deleted by watchdog
- stale locks are resolved by the lock owner system, gateway
- watchdog remains a policy engine, not a lock janitor

## Why Takeover Is Better Than Blind Delete

Blind delete loses evidence.

A proper stale-takeover flow preserves:

- who owned the lock before
- how stale it was
- whether the owner process still existed
- whether the new owner took it over

That is better for:

- journaling
- operator debugging
- safer recovery

## Migration Steps

1. Add gateway-level liveness lock schema and API.
2. Add extension registration metadata for liveness lock policy.
3. Migrate memory singleton lock from `memory_extension_locks` to gateway.
4. Change memory startup/heartbeat to use gateway lock lifecycle instead of direct DB ownership.
5. Change gateway `/health` to expose extension liveness lock state in a structured way.
6. Change watchdog to consume gateway lock evidence and prefer `gateway.restart_extension("memory")`.
7. Remove memory-specific watchdog DB probing.
8. Later, evaluate whether additional locks like memory processing lease should migrate too.

## Decision Rule

When implementing a lock or lease in an extension, stop and ask:

Is this lock primarily about:

- extension-internal coordination?

or about:

- liveness
- recovery
- operator observability
- restart policy

If it is the second category, it should cross a high bar for becoming a gateway concern.

That is the main lesson from the memory wedge:

- extension-local lock logic was fast to build
- but once recovery and watchdog policy depended on it, the coupling became undesirable

That is the signal that the abstraction belongs higher in the stack.
