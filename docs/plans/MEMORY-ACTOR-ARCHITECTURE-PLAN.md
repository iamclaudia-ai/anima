# Memory Actor Architecture Plan

Date saved: 2026-03-30

## Goal

Re-architect the memory extension so that no single stuck task can block the entire extension.

The immediate target is:

- `health_check` must stay responsive
- transcript ingestion must continue independently
- conversation readiness / queueing must continue independently
- at most one conversation may be in `processing`
- Libby, file writes, DB updates, git commit, and git push must not block unrelated memory work

## Root Problem

Today, the first failure domain is the shared extension host transport, not memory-specific business logic.

Current host behavior:

- extension host reads stdin messages line-by-line
- each line is processed with `await handler(line)`
- one stuck request or event blocks all later requests and events for that extension

This means a stuck memory operation can block:

- `memory.health_check`
- `gateway.heartbeat`
- all later RPC methods
- all later event delivery

Inside memory, long-running work is also mixed into the same process and request path:

- watcher-triggered ingest
- heartbeat-driven readiness updates
- queueing work
- Libby RPC calls
- file writes
- DB status updates
- git commit
- git push

The result is a single logical mailbox with mixed control-plane and data-plane work.

## Design Principles

1. Control-plane work must never depend on long-running jobs.
2. Long-running jobs may run as long as they need, but only within their own lane.
3. SQLite remains the source of truth for coordination and recovery.
4. No long external call may hold a DB transaction open.
5. Actor boundaries should align with failure domains.
6. Health should report actor-level status, not just process-level status.

## Architecture

Split memory into independent actors/services:

1. `HealthActor`

- owns in-memory diagnostics snapshot
- serves `memory.health_check`
- records actor heartbeat timestamps
- never waits on Libby, watcher, or git

2. `IngestActor`

- accepts file-change jobs
- deduplicates by file key
- ingests transcript deltas
- rebuilds conversations for affected files
- performs short DB transactions only

3. `SchedulerActor`

- periodically marks `active -> ready`
- periodically claims `ready -> queued`
- does not depend on gateway heartbeat delivery
- runs on its own timer with short DB work

4. `ProcessingActor`

- single-flight actor for conversation processing
- atomically claims one queued conversation
- marks `queued -> processing`
- runs Libby for that conversation only
- never blocks health, ingest, or scheduler lanes

5. `RepoSyncActor`

- owns post-processing repository work
- handles local commit and remote sync policy
- push is best-effort and retryable
- remote sync failures do not hold a conversation in `processing`

## Proposed Responsibility Map

### Health

Owned by `HealthActor`.

- reply from cached in-memory actor state plus bounded DB reads
- no dependency on queued request ordering behind long work
- report:
  - control lane status
  - ingest lane status
  - scheduler lane status
  - processing lane status
  - repo sync lane status
  - lock owner and lock heartbeat age

### Transcript Ingest

Owned by `IngestActor`.

- watcher only enqueues jobs
- manual ingest also enqueues jobs
- one file job at a time within this actor
- dedupe repeated changes for the same file

### Chunking Into Conversations

Owned by `IngestActor` during file rebuild.

- file ingest updates transcript rows
- rebuild conversations only for the affected file/session scope
- no coupling to Libby or repo sync

### Mark Ready

Owned by `SchedulerActor`.

- periodic timer checks gap threshold
- short DB transaction
- emits diagnostics/event only after DB change

### Mark Queued

Owned by `SchedulerActor`.

- separate periodic timer or same scheduling tick
- moves eligible `ready -> queued`
- bounded batch size

### Claim First Queued

Owned by `ProcessingActor`.

- atomically claim one conversation
- enforce singleton processing in DB, not just in memory
- use a lease / heartbeat on the processing work item

### Libby Processing

Owned by `ProcessingActor`.

- long-running RPC to session extension is allowed
- if it wedges, only the processing lane is impacted
- health and ingest must continue

### File / DB Updates

Split ownership:

- `ProcessingActor`: writes memory files and updates conversation processing metadata
- `RepoSyncActor`: handles repo-level synchronization

All DB status transitions remain short and explicit:

- `queued -> processing`
- `processing -> written`
- `written -> archived` or `review` or `skipped`
- repo sync status tracked separately from conversation archival status

### Git Commit / Push

Move to `RepoSyncActor`.

Recommended policy:

- local file write success is the durable success boundary for memory generation
- local commit may remain in the processing critical path initially
- remote push should not remain in the processing critical path

Preferred steady-state:

1. `ProcessingActor` writes files
2. `ProcessingActor` records conversation outcome
3. `RepoSyncActor` stages/commits/pushes asynchronously
4. sync retries happen independently

## Extension Host Changes

The host must stop serializing the entire extension behind one awaited stdin loop.

Required host behavior:

1. Parse inbound messages immediately.
2. Dispatch by message type to independent executors.
3. Allow concurrent in-flight method handling.
4. Give internal control traffic a priority lane:
   - health
   - heartbeat/event delivery needed for liveness
5. Add per-extension and per-method concurrency limits.
6. Track pending request counts and actor queue depth for diagnostics.

### Impact On Other Extensions

This is a shared runtime change, so it affects every process-based extension, not just memory.

Benefits for all extensions:

- one long RPC no longer blocks unrelated health checks
- one slow event handler no longer blocks all later events
- better isolation between control traffic and business logic

Risks for other extensions:

- extensions that accidentally relied on host-level serialization may now see true concurrency
- mutable per-request globals in the host context become unsafe under concurrency
- event ordering assumptions may break if not made explicit

Therefore the host change should include a compatibility model:

1. Add host-level concurrency modes:

- `serial`
- `concurrent`
- `priority_control`

2. Default existing extensions to conservative behavior initially:

- regular methods may remain serial by default
- control methods may be allowed on a separate priority lane

3. Opt memory into stronger concurrency first.

4. Audit other extensions for context-safety before enabling wider concurrency.

Important host note:

The current host stores request context in mutable globals (`currentConnectionId`, `currentTags`, etc.). That must be replaced or isolated before concurrent request handling is enabled.

Safer options:

- pass request context explicitly into every handler call
- use `AsyncLocalStorage`-style request scoping if Bun behavior is reliable enough
- avoid shared mutable request context entirely

## Memory Data Model Changes

Add explicit work-item / lease tracking for processing and sync.

Suggested additions:

- `memory_processing_runs`
  - `conversation_id`
  - `status`
  - `owner_pid`
  - `lease_heartbeat_at`
  - `started_at`
  - `updated_at`
  - `error`

- `memory_repo_sync_runs`
  - `conversation_id`
  - `status`
  - `commit_sha`
  - `attempt_count`
  - `last_attempt_at`
  - `last_error`

This separates:

- conversation semantic status
- processing worker lease state
- repo sync state

## Failure Model

### If Ingest wedges

- `HealthActor` remains responsive
- `SchedulerActor` and `ProcessingActor` continue
- ingest queue depth and stale heartbeat become visible in health

### If Scheduler wedges

- health and ingest continue
- ready/queued counts stop moving
- scheduler heartbeat reveals issue

### If Libby wedges

- only `ProcessingActor` is affected
- conversation lease heartbeat goes stale
- recovery moves stale `processing` work back to `queued`
- health remains responsive

### If Git push wedges

- repo sync lane is affected
- conversation is already durable locally
- retries continue separately
- health reports degraded sync, not dead memory

## Rollout Plan

### Phase 1: Host Safety Layer

1. Add control-lane priority to extension host.
2. Stop one stuck regular request from blocking health checks.
3. Remove shared mutable request context from host internals.
4. Add host metrics:

- in-flight requests
- queue depth
- oldest pending request age

### Phase 2: Memory Internal Split

1. Introduce actor boundaries inside memory.
2. Move health to cached actor diagnostics.
3. Move scheduling off gateway heartbeat and onto internal timers.
4. Keep existing business logic, but run it behind actor queues.

### Phase 3: Processing Lease Model

1. Add explicit DB lease for `processing`.
2. Make stale processing recovery actor-specific.
3. Ensure only one claimed processing item at a time.

### Phase 4: Repo Sync Isolation

1. Split local archival success from remote push success.
2. Move push to `RepoSyncActor`.
3. Add retries and degraded sync reporting.

### Phase 5: Tighten Health Contract

1. Health must be bounded and independent.
2. Add per-actor heartbeat timestamps.
3. Add degraded/unhealthy states by actor.

## Open Questions

1. Should local git commit remain in the processing critical path, or also move fully to `RepoSyncActor`?
2. Do we want one Bun process with multiple internal actors, or separate child processes for processing and repo sync?
3. Is per-extension host concurrency enough, or do we also want per-method concurrency declarations?
4. Should scheduler timing be fixed intervals, or event-assisted with periodic backstop?

## Recommended Decisions

1. Keep memory as one extension process initially, but split it into internal actors first.
2. Change the extension host so control traffic is no longer blocked by regular work.
3. Move `git push` out of the conversation processing critical path.
4. Treat actor heartbeats as first-class health signals.
