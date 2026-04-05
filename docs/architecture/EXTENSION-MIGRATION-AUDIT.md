# Extension Migration Audit

Date: 2026-04-02

## Summary

Not every extension has been migrated to the new runtime container model yet.

The current state is:

- the shared runtime and scheduler are in place
- the three most stateful extensions in the critical path, `session`, `memory`, and `voice`, are migrated
- most other extensions are still compatible with the runtime, but still use the older direct `AnimaExtension` implementation style

## Fully Migrated

### `session`

Status:

- uses `createStandardExtension<SessionExtensionRuntime>()`
- uses method execution metadata
- uses runtime services instead of loose mutable globals

Key runtime services:

- prompt/session actor registry
- agent-host bridge
- session registry

Primary reason it was migrated first:

- this was directly responsible for user-facing timeouts like `session.list_workspaces`

### `memory`

Status:

- uses `createStandardExtension<MemoryExtensionRuntime>()`
- uses method execution metadata
- startup, shutdown, health, and method routing all go through the shared runtime container

Primary reason it was migrated first:

- this exposed the original “one stuck task wedges everything” failure very clearly

### `voice`

Status:

- uses `createStandardExtension<VoiceExtensionRuntime>()`
- uses method execution metadata
- owns per-connection stream state behind a runtime service instead of loose globals

Primary reason it was migrated next:

- it sits directly on the session event pipeline and browser audio stream path
- it needed keyed isolation by `connectionId`, not extension-wide serialization

## On Shared Scheduler, But Not On Runtime Container Yet

These extensions still benefit from the improved extension-host scheduling, because every extension process now runs behind the same `RequestScheduler`.

They are not blocked the way the old host blocked traffic, but they have not yet been rewritten to use the standard runtime container helper.

### Lower-Risk / Simpler

- `chat`
- `control`
- `presenter`
- `testroute`

These are mostly small and can migrate with low risk when convenient.

### Medium Complexity

- `hooks`
- `scheduler`
- `disco`
- `audiobooks`
- `dominatrix`

These have more local state or more involved startup behavior and should migrate intentionally rather than mechanically.

### Tricky / Stateful Interactive

- `imessage`

These are the most important remaining migrations after `session`, `memory`, and `voice`.

Why:

- they keep long-lived runtime state
- they subscribe to events
- they have connection or stream specific behavior
- they are more likely to benefit from explicit keyed services/actors

## Extensions Not In Scope For Process-Host Migration

Some extension directories are not really part of the process-host migration story in the same way.

Examples:

- `bogart`
- `editor`

These should be evaluated separately based on whether they actually expose a process-hosted server extension surface.

## Agent-Host Audit

`packages/agent-host` was reviewed as part of this work.

Conclusion:

- no major concurrency redesign was required there for this pass
- the request-response and event-broadcast model in agent-host was already separate from the extension-host bottleneck
- the main session-side change was adding a clearer bridge abstraction in the session extension

Relevant files:

- [server.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/agent-host/src/server.ts)
- [session-host.ts](/Users/michael/Projects/iamclaudia-ai/anima/packages/agent-host/src/session-host.ts)
- [agent-client.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/agent-client.ts)
- [session-agent-bridge.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-agent-bridge.ts)

## Recommended Migration Order

1. `imessage`
2. `hooks`
3. `scheduler`
4. simpler extensions as cleanup work

## Migration Rule Of Thumb

An extension should be migrated if one or more are true:

- it has long-lived runtime state
- it subscribes to gateway events
- it talks to an external process or API over a persistent connection
- it owns a background loop, watcher, or scheduler
- it needs keyed isolation by connection, session, or stream

If none of those are true, the migration is mostly a cleanup and consistency task.
