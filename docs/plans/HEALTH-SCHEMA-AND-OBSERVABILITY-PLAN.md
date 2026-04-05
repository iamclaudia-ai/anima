# Health Schema And Observability Plan

Date: 2026-04-05

## Problem Summary

The current health-check contract is too weak for the system Anima has become.

Today the shared contract is roughly:

- `ok`
- `status`
- `label`
- `metrics[]` as flat label/value pairs
- `items[]` as table rows

That was enough for generic cards, but it breaks down for stateful systems like:

- `memory`
- `session`
- `voice`
- watchdog-managed services

The biggest issue is `metrics[]`:

- it becomes a dumping ground for unrelated values
- grouping is implicit and inconsistent
- Mission Control has to infer structure from labels
- the UI cannot reason cleanly about subsystem state

## Goals

1. Replace flat health metrics with structured JSON sections.
2. Preserve a generic top-level contract for discovery and rendering.
3. Allow each extension to define a typed health schema for its own domain.
4. Make Mission Control and watchdog UIs simpler to build, not more dynamic and fragile.
5. Improve observability for degraded/recovering states, not just healthy/down.

## Design Principles

### 1. Generic Envelope, Typed Body

Keep one shared envelope for all health checks.

The envelope should answer:

- what thing is this?
- what is its top-level health state?
- what typed schema should the UI use to render the rest?

The body should answer:

- what subsystems exist?
- what state are they in?
- what resources are being managed?
- what incidents/recovery actions are active?

### 2. Prefer Structured Sections Over Flat Metrics

Bad:

- `[{ label: "Watcher Ready", value: "true" }, ...]`

Better:

- `sections.runtime.watcher.ready = true`

This makes grouping, rendering, and validation much easier.

### 3. Item-Level Visibility Matters

You are right that item-level entries should be used much more.

For stateful extensions, items should represent real managed resources such as:

- memory conversations
- hot transcript files
- prompt sessions
- voice connections
- scheduler tasks
- open incidents

Items are the operator-facing view. They should not be an afterthought.

## Proposed Shared Contract

Replace the current loose `HealthCheckResponse` shape with a more structured version.

Suggested direction:

```ts
interface HealthCheckResponse<TSections = unknown, TItems = unknown> {
  ok: boolean;
  status: "healthy" | "degraded" | "recovering" | "disconnected" | "error";
  label: string;
  schema: string;
  summary?: {
    message?: string;
    updatedAt?: string;
    lastGoodAt?: string | null;
  };
  sections?: TSections;
  items?: TItems[];
  actions?: HealthAction[];
}
```

Key addition:

- `schema`

This is the typed schema identifier the UI uses to select a renderer.

Examples:

- `health.memory.v1`
- `health.session.v1`
- `health.voice.v1`
- `health.watchdog.service.v1`

## UI Rendering Model

Mission Control should remain extension-agnostic at the shell level, but it should not be forced to render every schema through one generic card.

The right model is:

- shared health envelope
- schema id on every health payload
- registry of optional schema-specific React renderers
- generic structured fallback renderer when no custom view is registered

This is the same general pattern Anima already uses for extension-provided route registration.

### Proposed Boundary

`control` owns:

- polling and refresh behavior
- layout and card shell
- search, filters, sorting
- incident timeline / recovery history shell
- generic structured fallback renderer
- schema-to-component registry lookup

An extension may optionally provide:

- schema types
- schema validator / normalizer
- one or more React health card components
- summary helpers for compact list views

This keeps Mission Control generic by default while still allowing rich domain-specific rendering for complex systems like `memory`, `session`, and `voice`.

### Registration Model

Health UI should be registered by `schema`, not by extension name.

Bad:

- `if (extension.name === "memory") renderMemoryCard(...)`

Better:

- `if (health.schema === "health.memory.v1") render registered schema view`

Suggested direction:

```ts
export interface HealthViewRegistration<T = unknown> {
  schema: string;
  Component?: React.ComponentType<{ health: HealthCheckResponse<T> }>;
  renderSummary?: (health: HealthCheckResponse<T>) => {
    title?: string;
    subtitle?: string;
    badges?: string[];
  };
}
```

Then Mission Control uses one registry:

```ts
const healthViews: HealthViewRegistration[] = [
  memoryHealthView,
  sessionHealthView,
  voiceHealthView,
];
```

At render time:

1. read `health.schema`
2. look up a registered view
3. render custom component if found
4. otherwise render `StructuredHealthCard`

### Discovery Path

There should be a shared registry exposed from the gateway/control side so Mission Control can query what health UI schemas are available without hardcoding card imports inside the page itself.

Recommended direction:

- each extension package can export optional `healthViews`
- gateway/control aggregates those exports into one `healthViewRegistry`
- Mission Control imports the registry and resolves by `schema`

That keeps storage/registration centralized while allowing ownership to stay with the extension package.

Possible shape:

```ts
export interface ExtensionUiRegistration {
  routes?: ExtensionRouteRegistration[];
  healthViews?: HealthViewRegistration[];
}
```

This can live beside the existing extension UI/route registration model instead of inventing a completely separate plugin mechanism.

### Why This Is Not Too Much Coupling

This is acceptable coupling because:

- gateway already depends on extension packages for UI route registration
- the contract boundary is narrow and declarative
- Mission Control does not import extension runtime internals
- extensions are optional contributors, not mandatory custom renderers

The control UI remains extension-agnostic in behavior:

- discovery is generic
- health polling is generic
- fallback rendering is generic

Only schema-specific presentation is customized.

## Proposed Shared Section Model

There should still be some conventions even if schemas are extension-specific.

Recommended top-level sections:

- `runtime`
  - process/host/liveness/freshness
- `subsystems`
  - watcher, scheduler, bridge, repo sync, etc.
- `workload`
  - queue depth, active jobs, lag
- `recovery`
  - incident state, last action, restart count
- `dependencies`
  - external services and connectivity

Extensions can omit sections they do not need.

## Example: Memory Health Shape

```ts
interface MemoryHealthV1 {
  runtime: {
    mode: "active" | "passive" | "recovering";
    process: {
      pid: number | null;
      lockOwnerPid: number | null;
      lockHeartbeatAgeMs: number | null;
      lastGoodHealthAt: string | null;
    };
  };
  subsystems: {
    watcher: {
      status: "ready" | "coalescing" | "lagging" | "stuck";
      ready: boolean;
      queueDepth: number;
      hotFiles: number;
      hottestFile: string | null;
      lastIngestAt: string | null;
    };
    scheduler: {
      status: "running" | "lagging" | "stopped";
      lastRunAt: string | null;
    };
    processor: {
      status: "idle" | "processing" | "stuck";
      currentConversationId: number | null;
      processingLeaseAgeMs: number | null;
    };
    repoSync: {
      status: "idle" | "syncing" | "retrying" | "error";
      pendingRequests: number;
      lastCompletedAt: string | null;
      lastError: string | null;
    };
  };
  workload: {
    filesTracked: number;
    conversations: {
      active: number;
      ready: number;
      queued: number;
      processing: number;
      archived: number;
      skipped: number;
    };
  };
  recovery: {
    incidentOpen: boolean;
    currentStage: "none" | "suspect" | "soft_recover" | "restart" | "escalated";
    lastAction: string | null;
    lastActionAt: string | null;
  };
}
```

Items for memory should include:

- active conversations
- hot files
- open incidents

The custom UI renderer for `health.memory.v1` should prioritize:

- watcher freshness and ingest lag
- hot file churn
- queued/processing conversation state
- repo sync backlog
- current incident and recovery history

## Example: Session Health Shape

`session` should expose structured sections for:

- bridge connectivity
- active sessions
- stale sessions
- background tasks
- recent failures

Items should include:

- active prompt sessions
- stale sessions
- running tasks

The custom UI renderer for `health.session.v1` should prioritize:

- agent-host bridge connectivity
- active prompt actors
- stale/blocked session indicators
- task backlog and recent failures

## Example: Voice Health Shape

`voice` should expose structured sections for:

- runtime process state
- Cartesia dependency state
- active per-connection streams
- stream lag or backlog

Items should include:

- active browser connections
- active voice streams

The custom UI renderer for `health.voice.v1` should prioritize:

- active connections and stream counts
- per-connection synth state
- dependency health for Cartesia / browser stream path

## Watchdog Status Should Use The Same Model

Watchdog should stop publishing only:

- `healthy: boolean`

It should move to a structured service-health payload too.

## Mission Control Rendering Strategy

Mission Control should render in three layers:

1. Generic shell

- extension/service name
- top-level status
- last update / last good health
- quick summary badges

2. Schema-specific body when available

- render component from `healthViewRegistry`

3. Generic fallback body

- render `summary`
- render structured `sections`
- render `items`
- render `actions`

This gives us a smooth migration path:

- old extensions continue to work through the fallback
- migrated extensions get richer cards
- Mission Control itself stays stable as more schemas are added

## Implementation Plan Addendum

1. Extend shared health types with `schema`, `summary`, and `sections`.
2. Add `HealthViewRegistration` and gateway/control-side `healthViewRegistry`.
3. Expose optional `healthViews` from extension packages alongside their UI registration model.
4. Build `StructuredHealthCard` as the default renderer.
5. Add first custom cards for:
   - `health.memory.v1`
   - `health.session.v1`
   - `health.voice.v1`
   - `health.watchdog.service.v1`
6. Migrate Mission Control page to registry lookup by `schema`.
7. Keep legacy `metrics` rendering only as a compatibility fallback during migration.

For each service:

```ts
interface WatchdogServiceHealthV1 {
  runtime: {
    pid: number | null;
    processAlive: boolean;
    status: "healthy" | "degraded" | "recovering" | "unhealthy" | "down";
    healthReason: string | null;
    lastGoodAt: string | null;
  };
  recovery: {
    consecutiveFailures: number;
    lastRestart: string | null;
    restartCountWindow: number;
    currentAction: string | null;
  };
  history: Array<{
    timestamp: string;
    status: string;
    reason: string | null;
  }>;
}
```

## Rendering Strategy

### Current Problem

Mission Control is currently too dynamic in the wrong way:

- discover extension
- call health method
- render generic flat metrics

That works for toy cards but not for operational systems.

### Proposed Strategy

Use renderer selection by schema.

Flow:

1. Gateway discovers health-capable extensions.
2. Extension returns `schema`.
3. Mission Control picks:
   - specific renderer for known schemas
   - generic fallback for unknown schemas

Examples:

- `health.memory.v1` -> `MemoryHealthCard`
- `health.session.v1` -> `SessionHealthCard`
- `health.voice.v1` -> `VoiceHealthCard`
- unknown schema -> generic JSON section renderer

This preserves extensibility without forcing every health card to be hardcoded from day one.

## Migration Plan

### Phase 1: Shared Contract Extension

1. Extend shared types to support:
   - `schema`
   - `summary`
   - `sections`
2. Keep `metrics` temporarily for compatibility.
3. Update docs to mark flat `metrics` as legacy/fallback.

### Phase 2: Mission Control Renderer Model

1. Update Mission Control to prefer:
   - schema renderer
   - then generic sections renderer
   - then legacy metrics fallback
2. Improve item rendering for resource-heavy extensions.

### Phase 3: Extension Migrations

Migrate in this order:

1. `memory`
2. `session`
3. `voice`
4. watchdog dashboard service payloads
5. remaining extensions as needed

### Phase 4: Deprecate Flat Metrics

Once enough extensions are migrated:

- stop adding new flat metrics
- keep `metrics` only for generic fallback and older extensions

## Testing Strategy

1. Shared type tests for the new health envelope.
2. Mission Control tests for schema-driven rendering.
3. Extension tests for schema shape stability.
4. Backward-compat tests to ensure legacy `metrics` payloads still render.

## Recommended First Slice

The highest-value first slice is:

1. add `schema`, `summary`, and `sections` to the shared health contract
2. implement `health.memory.v1`
3. add a `MemoryHealthCard` renderer in Mission Control
4. keep existing flat metrics as a fallback during migration

This gives immediate structure where it matters most without forcing a full system rewrite.
