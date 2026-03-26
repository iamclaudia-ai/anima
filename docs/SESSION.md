# Session Extension

The session extension is the brain of the operation. It sits between the gateway (a pure message hub) and the agent-host (which owns the actual SDK processes), orchestrating everything in between: workspace identity, session bootstrapping, prompt dispatch, memory continuity, task delegation, and async event routing.

If the gateway is the nervous system, this extension is the cortex.

```text
Client
  │  gateway req/res + event stream
  ▼
Gateway (pure hub)
  │  ctx.call / extension host protocol
  ▼
Session Extension
  │
  ├─ Session store + workspace DB (SQLite)
  ├─ Claude project discovery (~/.claude/projects)
  ├─ Memory integration (memory.*)
  └─ AgentHostClient (WebSocket)
        │
        ▼
    Agent Host
      ├─ SessionHost (Claude SDK sessions)
      └─ TaskHost (Codex tasks)
```

## What It Owns (and What It Doesn't)

**Owns:**

- Draft session creation (fast, no SDK call)
- Lazy bootstrapping on first prompt (memory context, system prompt injection)
- Workspace ↔ session mapping
- Session discovery from Claude's JSONL transcript files
- Session switching/resetting with memory continuity
- Delegated task coordination and completion notifications
- The entire `session.*` API surface

**Doesn't own:**

- The Claude SDK runtime process (that's agent-host)
- The WebSocket client protocol (that's gateway)
- Memory ingestion into SQLite (that's the memory extension)

Clean boundaries. Each system does one thing well.

## Architecture: The Pull Model

Every lifecycle module in the session extension follows a **pull-based runtime pattern**. Instead of receiving dependencies at construction time (push), modules reach into a shared runtime singleton when they need something:

```text
index.ts                          lifecycle modules
  │                                    │
  │  initRuntime({                     │
  │    ctx, agentClient,               │
  │    sessionConfig, ...              │
  │  })                                │
  │         │                          │
  │         ▼                          │
  │    ┌─────────────┐                 │
  │    │  runtime.ts  │◄───────────────│  getRuntime()
  │    │  (singleton) │                │
  │    └─────────────┘                 │
  │                                    │
```

`runtime.ts` is ~50 lines: `initRuntime()`, `getRuntime()`, `resetRuntime()`. It holds the extension context, agent-host client, session config, and shared state maps (request contexts, task cache, etc.).

This means lifecycle modules are **plain exported functions** — no factories, no interfaces, no DI wiring. They just call `getRuntime()` at execution time and get what they need. The result is an `index.ts` that's ~170 lines of config + init + extension interface, instead of a 790-line monolith.

### The Circular Dependency Trick

One subtlety: `prompt-lifecycle` needs to call `session.create_session` (when a persistent session doesn't exist yet), and `session.create_session` lives in `session-dispatch`, which also calls `prompt-lifecycle` for `session.send_prompt`. Classic circular dependency.

The solution is a **late-bound `dispatchMethod`** reference on the runtime — essentially the session extension's own version of `ctx.call()`. It's set after everything is initialized, and modules access it at execution time through `getRuntime().dispatchMethod`. The runtime acts as an indirection layer that breaks the cycle at construction time while allowing it at call time.

## Core Model

Three related but distinct concepts:

### 1. Draft Session

Created by `session.create_session`. Gets a UUID and metadata row in the session DB instantly — no SDK call, no memory fetch, no blocking. This makes session creation feel immediate and eliminates UI double-click races.

### 2. Materialized Session

A draft becomes materialized when the agent-host creates or resumes the actual Claude SDK session for that UUID. This happens **lazily on first prompt** — the expensive work only runs when the user is already waiting for model output.

### 3. Persistent Session Alias

Some callers (like iMessage) use the sentinel `PERSISTENT_SESSION_ID` instead of a real UUID. The prompt lifecycle resolves this to a per-workspace session ID before continuing normal flow. The mapping lives in the extension's persistent store and supports rotation based on message count or age.

## Prompt Lifecycle

The heart of the extension. Lives in `lifecycle/prompt-lifecycle.ts`.

```text
runPromptLifecycle(input, request)
  │
  ├─ resolveSessionStage
  │    resolve persistent alias → real session ID
  │    load stored session from DB
  │    infer cwd / workspace / model
  │
  ├─ prepareRuntimeStage
  │    detect model drift (running model ≠ desired model)
  │    recycle SDK runtime if needed
  │    upsert draft session if new
  │
  ├─ bootstrapSessionStage
  │    skip if Claude session file already exists
  │    transition previous conversation (memory)
  │    fetch memory context for system prompt
  │    create Claude session via agent-host
  │
  ├─ attachRequestContextStage
  │    install primary/transient stream routing state
  │    preserve primary context for concurrent callers
  │
  └─ dispatchPromptStage
       streaming: fire-and-forget + turn listener
       non-streaming: await turn_stop with 5min timeout
```

The key insight is the **create vs first-prompt split**: `session.create_session` is cheap (just a DB row), and `session.send_prompt` absorbs the bootstrapping cost. The user is already waiting for model output, so the overhead is invisible.

This module also owns `resolvePersistentSession`, `ensureSessionBootstrapped`, and `buildBootstrapSystemPrompt` — they're internal helpers that only the prompt lifecycle needs, so they live here rather than floating around in `index.ts`.

## Session Activation

Lives in `lifecycle/session-activation.ts`. Two flows:

**Switch session** — resume an existing session in a workspace:

```text
switchSession({ sessionId, cwd, model? })
  ├─ resolve/create workspace
  ├─ transition previous conversation (memory continuity)
  ├─ recycle runtime if model drift detected
  ├─ prompt empty string to lazily resume runtime
  ├─ upsert stored session
  └─ set workspace active session
```

**Reset session** — start fresh in a workspace:

```text
resetSession({ cwd, model? })
  ├─ resolve/create workspace
  ├─ capture previous active session ID
  ├─ transition previous conversation (memory continuity)
  ├─ create fresh agent-host session
  ├─ persist with previousSessionId link
  └─ set workspace active session
```

Both flows call `memory.transition_conversation` first — ensuring the memory system processes the outgoing conversation before we move on.

## Query & Discovery

Lives in `lifecycle/session-query.ts`. Read-only operations:

- **`listSessions(cwd)`** — discovers sessions from Claude's local project files under `~/.claude/projects/`, enriches the session DB with metadata (message count, first prompt, git branch), and returns a merged, sorted list.

- **`getHistory(params)`** — reads paginated transcript history from Claude's JSONL session files. Also extracts usage/cost data.

- **`getMemoryContext(cwd?)`** — previews the exact memory block that would be injected into a new session bootstrap. Useful for debugging memory continuity.

Session discovery works by scanning Claude's project directory structure: `~/.claude/projects/{encoded-cwd}/sessions-index.json` and `.jsonl` transcript files. This data enriches (rather than replaces) the session DB.

## Event Bridges

Two bridges adapt async events from the agent-host back into gateway events.

### Session Events (`lifecycle/session-events.ts`)

Adapts `agentClient` session events → gateway `ctx.emit`:

- Restores `connectionId` and `tags` for async stream events (the original RPC call has already returned, so routing context must be preserved explicitly)
- Merges primary and transient tags correctly for concurrent callers
- Updates stored runtime status on state transitions
- Accumulates response text for non-streaming callers

### Task Events (`lifecycle/task-events.ts`)

Same pattern for delegated tasks:

- Updates the in-memory task map from host events
- Persists task status and metadata to the session DB
- Emits scoped events (`session.task.{taskId}.{type}`)
- Sends completion notifications to the parent session via `<user_notification>` prompt injection
- Deduplicates notifications to prevent double-sends

## Task Workflow

Lives in `lifecycle/task-workflow.ts`. Tasks are the delegation model — fire off a code review, test run, or general task to a sub-agent.

Tasks are **session-centric**: stored as child sessions with `parentSessionId` linking back to the chat session. This means the existing session DB, query, and discovery machinery all work for tasks too.

```text
startTask(params, request)
  ├─ resolve parent session and effective cwd
  ├─ call agent-host TaskHost
  ├─ persist as child session with task metadata
  ├─ cache in memory
  └─ return task handle

task.event (via wireTaskEvents)
  ├─ update in-memory task state
  ├─ persist status/metadata
  ├─ emit scoped gateway event
  └─ notify parent session on completion

listTasks / getTask
  └─ merge host state with stored sessions
      hydrate git info for worktree tasks
```

The `getTaskGitInfo` helper runs `git status`, `git branch`, and merge-base checks against worktree tasks — so you always know the current state of a delegated task's working directory.

## Method Dispatch

The API surface is split into two clean layers:

- **`session-methods.ts`** — static Zod schema definitions for every `session.*` method
- **`session-dispatch.ts`** — the switch that routes methods to lifecycle functions

Dispatch imports lifecycle functions directly (`runPromptLifecycle`, `switchSession`, `startTask`, etc.) and pulls shared state from the runtime. No dep injection, no indirection — just a method name → function call.

`index.ts` wraps dispatch with a thin logging/timing layer and exposes the extension interface.

## Data Sources

Four sources of truth, each with a clear owner:

| Source                   | Location                 | What It Stores                                                                                   |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------ |
| **Session DB**           | `session-store.ts`       | Session metadata, runtime status, parent/previous links, task sessions, workspace active session |
| **Workspace DB**         | `workspace.ts`           | Workspace identity, cwd, general vs project-specific scope                                       |
| **Claude project files** | `~/.claude/projects/...` | JSONL transcripts, `sessions-index.json`, transcript-derived history                             |
| **Memory extension**     | `ctx.call("memory.*")`   | Conversation transitions, session context (recent messages + summaries)                          |

The session extension **consumes** memory; it doesn't own ingestion. It **enriches** the session DB from Claude project files; it doesn't replace them.

## File Map

```text
extensions/session/src/
├─ index.ts                        # Extension shell: config → initRuntime → interface
├─ runtime.ts                      # Pull-model singleton (init/get/reset)
├─ session-methods.ts              # Zod schema definitions for session.* API
├─ session-dispatch.ts             # Method → lifecycle function routing
├─ session-types.ts                # Shared types, helpers, runtime status mapping
├─ agent-client.ts                 # AgentHostClient (WebSocket RPC to agent-host)
├─ session-store.ts                # SQLite session/task storage
├─ workspace.ts                    # SQLite workspace storage
├─ claude-projects.ts              # Claude project directory discovery
├─ parse-session.ts                # JSONL transcript parser (paginated)
├─ memory-context.ts               # Memory block formatting for system prompts
├─ persistent-sessions.ts          # Persistent session alias resolution + rotation
└─ lifecycle/
    ├─ prompt-lifecycle.ts         # The big one: prompt pipeline + bootstrap
    ├─ session-activation.ts       # Switch/reset session flows
    ├─ session-query.ts            # List sessions, get history, memory preview
    ├─ session-events.ts           # Agent-host → gateway event bridge
    ├─ task-workflow.ts            # Task CRUD + git info
    └─ task-events.ts              # Task event bridge + completion notifications
```

## Design Philosophy

**Lazy materialization.** Creating a session is just a DB write. The expensive SDK + memory work happens on first prompt, when the user is already waiting.

**Pull over push.** Modules reach into the runtime when they need something, rather than receiving a bag of dependencies at construction time. Less boilerplate, easier to follow, and the runtime singleton is the only thing you need to understand to trace any call path.

**Explicit stages.** The prompt lifecycle is a pipeline of named stages, not a procedural blob. Each stage has a single responsibility and clear preconditions.

**Session-centric tasks.** Tasks aren't a separate concept — they're child sessions. This means all existing session infrastructure (storage, queries, discovery) works for tasks too.

**Internal by design.** The lifecycle structure is intentional, not accidental. We don't expose public hooks for core session behavior because we want explicit ordering, predictable error handling, and easy reasoning about side effects. If extensibility is needed later, it should map onto well-defined extension points rather than a general callback bus.
