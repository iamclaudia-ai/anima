# Watchdog Recovery

This document describes the current watchdog recovery process in Anima and the intended architectural direction for extension recovery.

## Scope

The watchdog directly supervises top-level services from `~/.anima/watchdog.json`.

Today that means:

- `gateway`
- `agent-host`
- `claude-remote`

The watchdog does **not** supervise `memory` as a separate OS process entry.
`memory` runs as an extension behind `gateway`.

That means recovery has two layers:

- what exists today
- the intended gateway-owned liveness-lock direction

Today, memory recovery is implemented as:

- gateway process supervision
- gateway health probing
- interim memory-specific evidence gathered from the shared Anima SQLite database

That direct memory-table probing is transitional, not the desired long-term abstraction.

## Core Model

For each configured service, the watchdog loop does this every health interval:

1. Check whether the process is alive.
2. If alive, run the service health probe.
3. Record a health snapshot in service history.
4. Update failure counters and backoff state.
5. Restart the service if failure policy says it is time.

The existing generic failure reasons include things like:

- `dead`
- `unreachable`
- `http_<status>`
- `zero_extensions`

## Current Memory Recovery Signal

The main failure mode we observed was:

- gateway still running
- memory extension process technically still alive
- memory singleton lock heartbeat stale
- `memory.health_check` timing out

That means a normal HTTP `200` from gateway is not enough to conclude the system is healthy.

To catch this, watchdog currently reads the memory singleton lock row from the Anima SQLite database:

- table: `memory_extension_locks`
- lock id: `memory-extension`

It derives:

- `ownerPid`
- `heartbeatAgeMs`
- `stale`
- `ownerAlive`

From that it can emit two specific health reasons:

- `memory_stale_lock`
  The lock owner process still exists, but the heartbeat is stale.
- `memory_orphaned_lock`
  The lock heartbeat is stale and the recorded owner PID no longer exists.

These are currently treated as gateway health failures.

This works, but it is not the target architecture, because watchdog should not need to understand memory-specific tables.

## Current Recovery Action

Today the watchdog can restart top-level services directly, and gateway already exposes `gateway.restart_extension` for hosted extensions.

The current watchdog implementation still recovers a stale memory lock by treating it as a gateway health failure.

That makes gateway restart the practical recovery action today, even though this is not the preferred steady state.

## Intended Recovery Action

The preferred direction is:

- gateway owns liveness locks for hosted extensions
- gateway reports stale liveness locks in its health/status surface
- watchdog remains decoupled from extension internals
- watchdog asks gateway to restart the affected extension with `gateway.restart_extension`
- watchdog only restarts gateway when gateway itself is unhealthy or unreachable

For a memory-only wedge, the desired recovery action is:

- restart `memory` through gateway

not:

- restart `gateway`

This is the cleaner separation of concerns.

## Restart Policy

The watchdog has two classes of restart threshold:

### Generic unhealthy service

Uses the standard threshold:

- `UNHEALTHY_RESTART_THRESHOLD`

This avoids flapping on transient failures.

### Memory stale-lock failure

Uses an immediate threshold:

- first qualifying check triggers restart eligibility

This is deliberate because a stale memory singleton lock is already evidence that memory progression stopped and did not self-recover.

Backoff still applies, so repeated restart loops are bounded.

Once liveness locks migrate into gateway ownership, this same policy should be applied to the gateway-reported extension lock state rather than watchdog inspecting extension tables directly.

## Incident Lifecycle

The watchdog now tracks one active incident per service/reason pair.

An incident is opened when a service becomes unhealthy for a specific reason, for example:

- `gateway:memory_stale_lock`
- `gateway:zero_extensions`
- `agent-host:unreachable`

Each incident tracks:

- reason
- opened time
- whether restart has already been requested for that incident

This prevents the watchdog from writing the same “failure detected” event over and over on every health tick.

### Incident states in practice

1. Failure detected
   The watchdog opens an incident if one is not already active for that service/reason.

2. Restart requested
   If the restart threshold is met and backoff allows it, watchdog records a single restart request for the active incident.

3. Restart completed
   After the service restart call succeeds, watchdog records completion.

4. Health restored
   Once the service becomes healthy again, watchdog closes the active incident and records restoration.

## Recovery Journal

The watchdog writes recovery events to a durable JSONL journal:

- `~/.anima/logs/watchdog-recovery.jsonl`

Each line is a structured event.

Current event types:

- `health_check_failed`
- `memory_stale_lock_detected`
- `restart_requested`
- `restart_completed`
- `health_restored`

This gives an operator-visible record of:

- what went wrong
- when watchdog noticed
- what restart was attempted
- whether the service recovered

The journal format is intentionally generic enough that the event source can later move from direct watchdog memory probing to gateway-reported lock incidents without changing the operator-facing model.

## Status Surface

Watchdog status now includes more than a boolean health flag.

For each service it exposes:

- `healthReason`
- `healthDetails`
- `consecutiveFailures`
- `activeIncident`
- `lastRestart`
- health history

For gateway, `healthDetails` may currently include memory lock evidence such as:

- lock owner pid
- heartbeat age
- whether the owner process still exists

This is enough for dashboards to explain why a service is unhealthy instead of only showing red/yellow/green.

## Current Limitations

The current system is intentionally incremental. The main limitations are:

- watchdog still understands memory-specific lock evidence directly
- watchdog still tends toward restarting gateway rather than targeting `memory`
- recovery journal is JSONL, not yet a first-class SQLite incident store
- Mission Control does not yet render incident timelines richly
- health payloads are not yet migrated to the structured schema system described in the health-schema plan

The main architectural limitation is:

- liveness/recovery-relevant locks are not yet gateway-owned

## Practical Example: Memory Wedge

The recovery sequence for the recent memory failure mode is now:

1. Memory wedges under file churn.
2. Memory singleton lock heartbeat stops advancing.
3. Watchdog gateway health probe reads the lock row and sees stale heartbeat.
4. Gateway health is marked unhealthy with reason `memory_stale_lock` or `memory_orphaned_lock`.
5. Watchdog opens an incident and writes a journal entry.
6. Restart threshold is met immediately for this reason.
7. Watchdog currently recovers by treating gateway as unhealthy and restarting it.
8. Restart completion is journaled.
9. When health becomes good again, watchdog closes the incident and records `health_restored`.

This should evolve into:

1. Memory wedges under file churn.
2. Gateway-owned memory liveness lease goes stale.
3. Gateway reports stale extension lock state.
4. Watchdog opens an incident without inspecting memory tables directly.
5. Watchdog asks gateway to restart `memory`.
6. Gateway clears or takes over the stale liveness lock as part of extension restart/startup.
7. Recovery is journaled and the incident closes when health is restored.

## Near-Term Next Steps

The next logical improvements are:

1. Migrate liveness/recovery locks to gateway ownership.
2. Change watchdog to use gateway-reported extension liveness lock state.
3. Prefer `gateway.restart_extension("memory")` when gateway is healthy.
4. Mission Control incident timeline UI backed by the recovery journal.
5. Structured health schemas so memory, session, voice, and watchdog can expose richer operator state without flat metric sprawl.
