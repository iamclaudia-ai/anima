# Memory Resilience And Recovery Plan

Date: 2026-04-05

## Problem Summary

`memory` is a core dependency for Anima, but the current failure mode is still too brittle:

- the process can remain alive while becoming non-responsive
- `memory.health_check` can stop returning even though the PID still exists
- the singleton lock heartbeat can go stale without triggering reliable recovery
- Mission Control and watchdog mostly collapse behavior into binary healthy/unhealthy states
- there is no durable incident journal that explains:
  - when degradation started
  - what evidence was observed
  - what recovery action was attempted
  - whether the action helped

This is especially visible under high JSONL churn in `~/.claude/projects`, where the memory watcher is too eager and can hammer the process during rapid turns.

## Current Failure Signature

Observed on April 5, 2026:

- gateway `memory.health_check` calls consistently hit the 15s fallback timeout
- the memory PID remained alive
- the memory singleton lock heartbeat stopped advancing
- the last useful memory logs stopped the previous evening
- a live process sample showed Bun threads blocked on internal unfair locks

This is consistent with a process-level wedge, likely triggered by the watcher/ingestion path under sustained file churn, not a slow health-check query.

## Goals

1. Hot transcript files should be coalesced and processed eventually, not immediately.
2. A wedged memory process should be detected and recovered automatically.
3. Health should expose progression, staleness, and recovery state, not only red/green.
4. Every incident and recovery attempt should be durably recorded for later review.
5. Recovery should be conservative enough to avoid premature kills, but decisive enough to prevent all-day wedges.

## Plan Overview

The work should be split into four tracks:

1. Ingestion throttling and watcher hardening
2. Granular health model
3. Recovery policy and watchdog integration
4. Durable incident and recovery journal

## Architecture Note: Use XState For Ingestion

The memory extension already uses XState for its top-level lifecycle in
[state-machine.ts](/Users/michael/Projects/iamclaudia-ai/anima/extensions/memory/src/state-machine.ts).

The watcher/ingestion cadence logic does not currently use XState. It is mostly:

- chokidar callbacks
- a keyed in-memory queue
- ad hoc processing flags

That is serviceable for a simple watcher, but this new resilience work is exactly the point where
the ingestion subsystem should become a proper state machine too.

### Recommendation

Introduce a dedicated XState ingestion actor, for example:

- `memoryIngestionMachine`

with explicit states such as:

- `idle`
- `coalescing`
- `ready`
- `ingesting`
- `backingOff`
- `degraded`

and keyed per-file ingest records that track:

- first seen
- last seen
- debounce window
- next eligible ingest time
- attempts
- last success
- last error

### Why XState Fits Here

- debounce/coalescing is temporal state, not just queue state
- hot files have state transitions, not just events
- recovery decisions become explicit and testable
- watchdog-facing diagnostics become easier to derive from machine state
- the model aligns with the rest of memory, which already uses XState for lifecycle control

### Scope Boundary

Do not force every per-file item into a full actor if that becomes too heavy.

A practical model is:

- one ingestion state machine actor for the watcher subsystem
- keyed file entries as machine context
- explicit events like:
  - `FILE_CHANGED`
  - `DEBOUNCE_ELAPSED`
  - `INGEST_STARTED`
  - `INGEST_SUCCEEDED`
  - `INGEST_FAILED`
  - `HOT_FILE_DETECTED`

This gives the system state-chart clarity without over-fragmenting runtime ownership.

## 1. Ingestion Throttling And Watcher Hardening

### Why

Memory does not need true real-time ingestion for active conversations.

The current session already holds active context in `session`. Memory only needs to catch up soon enough for background recall and long-term narrative continuity.

That means it is better to prefer:

- bounded ingestion pressure
- coalesced updates for hot files
- predictable eventual consistency

over:

- immediate ingestion of every JSONL write

### Proposed Design

Introduce a watcher-side hot-file dampening policy in `MemoryWatcher`:

- track pending files in a keyed map instead of a plain queue
- store:
  - `firstSeenAt`
  - `lastSeenAt`
  - `attemptCount`
  - `lastIngestStartedAt`
  - `lastIngestCompletedAt`
- do not ingest immediately on every `change`
- require a quiet period before ingesting a file

### Recommended Policy

For JSONL transcript files:

- default quiet-period debounce: `2000ms`
- hot-file debounce: if a file receives repeated changes within a short window, increase to `5000ms`
- minimum re-ingest interval per file: `3000ms`
- max coalescing delay: `15000ms`
  - even if the file keeps changing, force one ingest eventually

For markdown memory-doc watchers:

- keep similar logic, but lighter
- default quiet-period debounce: `1000ms`

### Queue Model

Replace the current FIFO-only watcher queue with a scheduler or ingestion machine that:

- coalesces repeated changes for the same file
- picks the next ready file whose quiet period has elapsed
- never allows the same file to re-enter processing continuously without pause

### Important Constraints

- never hold a DB transaction while waiting for debounce windows
- keep ingestion idempotent using current file offsets/high-water marks
- preserve current stuck-file recovery behavior

### Expected Outcome

Rapid turn streaming should produce:

- fewer ingest invocations
- fewer lock/contention opportunities in Bun/chokidar paths
- eventual transcript availability without real-time pressure

## 2. Granular Health Model

### Problem

Current health is too operator-hostile:

- watchdog largely reports healthy / unhealthy / down
- Mission Control shows a single extension status plus raw metrics
- there is no first-class representation of:
  - lag
  - stale heartbeat
  - recovery in progress
  - degraded but still serving
  - wedged process suspected

### Proposed Model

Keep the existing top-level contract compatible:

- `healthy`
- `degraded`
- `disconnected`
- `error`

But add a more explicit substatus model in metrics/details.

### Extension Health Phases

For `memory`, expose:

- `mode`
  - `active`
  - `passive`
  - `recovering`
- `responsiveness`
  - `responsive`
  - `slow`
  - `timed_out`
- `heartbeat`
  - `fresh`
  - `stale`
  - `missing`
- `watcher`
  - `ready`
  - `coalescing`
  - `lagging`
  - `stuck`
- `scheduler`
  - `running`
  - `lagging`
  - `stopped`
- `processor`
  - `idle`
  - `processing`
  - `stuck`
- `repo_sync`
  - `idle`
  - `syncing`
  - `retrying`
  - `error`

### New Metrics To Surface

Mission Control should be able to display at least:

- extension mode
- current owner PID
- lock heartbeat age
- last successful health-check age
- watcher ready
- watcher queue depth
- watcher coalesced files
- hottest file key
- time since last ingest
- scheduler last run age
- processing lease age
- repo sync last completed age
- current recovery state
- last recovery action
- incident open/closed state

### UI Semantics

Top-level card color:

- `healthy`
  - all critical freshness thresholds green
- `degraded`
  - process alive, but one or more subsystems stale or lagging
- `error`
  - process alive but clearly wedged or unable to serve
- `disconnected`
  - process missing or extension host unreachable

Item/resource statuses should use:

- `healthy`
- `inactive`
- `stale`
- `dead`

### Watchdog Status Semantics

Watchdog service status should evolve from:

- `healthy: boolean`

to:

- `status`
  - `healthy`
  - `degraded`
  - `recovering`
  - `unhealthy`
  - `down`

with explicit reasons and timestamps.

## 3. Recovery Policy And Watchdog Integration

### Problem

The current watchdog logic is mostly process-based:

- PID alive
- HTTP health endpoint reachable
- consecutive failure threshold

That is not enough for memory because memory can wedge while:

- the process still exists
- the singleton lock is still held
- gateway stays up

### Proposed Detection Signals

For memory, recovery decisions should consider all of:

- process alive
- extension host reachable
- `memory.health_check` response time
- memory singleton lock heartbeat age
- memory extension actor heartbeat age
- age since last successful memory health-check
- age since last ingest completion
- age since last scheduler run

### Recovery Ladder

Do not jump straight to kill.

Use escalating recovery:

1. `suspect`
   - first timeout or stale signal
   - mark incident open
   - no restart yet

2. `soft_recover`
   - extension-specific recovery request if available
   - examples:
     - restart watcher only
     - stop/recreate watcher subsystem
     - drop passive ownership if lock heartbeat mismatch

3. `restart_extension`
   - if health remains timed out and stale heartbeat crosses threshold
   - restart memory extension only

4. `escalate`
   - repeated failed restarts in a bounded time window
   - mark operator-visible critical incident

### Recommended Thresholds

Initial values:

- mark suspect after:
  - 1 timed-out health check plus stale lock heartbeat older than `2m`
- soft recovery after:
  - 2 consecutive failed health checks
- restart extension after:
  - 3 consecutive failed health checks and stale lock heartbeat older than `5m`
- escalate after:
  - 3 restart attempts within `30m`

These should be configurable.

### Self-Protection In Memory

Add a self-monitor inside `memory`:

- independent timer checks whether its own heartbeat/logical progress is advancing
- if it detects impossible local staleness while still holding the singleton lock:
  - emit a high-severity recovery event
  - optionally terminate itself cleanly so watchdog can restart it

This is safer than allowing a permanently wedged process to hold the singleton forever.

## 4. Durable Incident And Recovery Journal

### Problem

Right now there is no trustworthy answer to:

- when did the extension first go bad?
- how many timeouts happened?
- what recovery action was taken?
- did the system actually improve afterward?

### Proposed Journal

Add a durable recovery journal, ideally in SQLite.

Suggested tables:

- `runtime_incidents`
  - `id`
  - `service_id`
  - `component_id`
  - `incident_type`
  - `status`
  - `opened_at`
  - `closed_at`
  - `summary`
- `runtime_incident_events`
  - `id`
  - `incident_id`
  - `timestamp`
  - `severity`
  - `event_type`
  - `message`
  - `data_json`
- `runtime_recovery_actions`
  - `id`
  - `incident_id`
  - `timestamp`
  - `action_type`
  - `initiator`
  - `result`
  - `data_json`

### Event Examples

Record:

- health-check timeout observed
- lock heartbeat stale
- watcher lag threshold crossed
- recovery attempted
- restart completed
- post-restart health restored
- false positive recovery

### Operator Value

This allows:

- Mission Control incident timeline
- watchdog dashboard history with reasons
- postmortem confidence about whether a restart was justified
- tuning thresholds based on real evidence instead of guesswork

## Implementation Phases

### Phase 1: Immediate Stability

1. Add watcher debounce/coalescing for JSONL ingestion.
2. Add memory-side stale-progress detection.
3. Teach watchdog to restart memory on stale lock heartbeat plus repeated health timeout.
4. Log recovery attempts durably, even if only to a first-pass JSONL journal.

### Phase 2: Health Model

1. Extend memory health-check payload with subsystem freshness/recovery metrics.
2. Extend watchdog `/status` payload from boolean health to multi-state service status.
3. Update Mission Control to render:
   - degraded vs recovering vs unhealthy
   - recovery reason
   - last good health
   - open incident state

### Phase 3: Recovery Journal

1. Add durable incident tables.
2. Wire watchdog and memory recovery actions into the journal.
3. Add operator views in Mission Control and watchdog dashboard.

### Phase 4: Hardening

1. Add tests for hot-file churn.
2. Add tests for stale-heartbeat restart logic.
3. Add tests for recovery journal lifecycle.
4. Re-evaluate whether chokidar-in-Bun remains acceptable for both watchers in one process.

## Testing Strategy

### Memory Watcher

- repeated rapid `change` events on one JSONL file should coalesce
- different files should still progress independently
- a hot file should eventually ingest even under continuous writes
- XState transitions for `coalescing -> ready -> ingesting -> idle` should be explicitly covered

### Health / Recovery

- stale singleton heartbeat plus timed-out health should produce `degraded` then `recovering`
- a restarted extension should close the open incident if health returns
- a premature recovery should be visible in the journal as a false positive

### UI / Operator Experience

- Mission Control should show more than green/red
- watchdog dashboard should show reasoned state transitions
- incident and recovery history should survive process restarts

## Recommended First Slice

The highest-value next implementation slice is:

1. watcher debounce/coalescing for `MemoryWatcher`
2. watchdog memory-specific stale-heartbeat restart policy
3. first-pass incident/recovery journal
4. richer memory health metrics for freshness and recovery state

This gives immediate resilience gains without requiring a full observability redesign first.
