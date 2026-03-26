# Session System

The session extension owns Anima's conversational runtime: workspace/session identity, Claude session bootstrapping, prompt orchestration, session discovery, delegated task coordination, and event routing between the gateway and agent-host.

This doc reflects the current post-refactor structure, where lifecycle workflows are explicit modules rather than being embedded in one large `handleMethod` switch.

## Overview

At a high level, the session system sits between the gateway and the agent-host:

```text
Client
  │  gateway req/res + event stream
  ▼
Gateway
  │  ctx.call / extension host protocol
  ▼
Session Extension
  │
  ├─ Session store / workspace DB
  ├─ Claude project discovery (~/.claude/projects)
  ├─ Memory integration (memory.*)
  └─ AgentHostClient
        │
        ▼
    Agent Host
      ├─ SessionHost (Claude SDK sessions)
      └─ TaskHost (Codex tasks)
```

The key design principle is: the gateway is just a hub, the agent-host owns the SDK processes, and the session extension owns the domain workflow that turns user intents into session lifecycle operations.

## Responsibilities

The session extension is responsible for:

- creating draft sessions quickly
- bootstrapping real Claude sessions on first prompt
- restoring and routing async stream events
- mapping workspaces to active sessions
- discovering transcript history from Claude JSONL files
- switching/resetting sessions with memory continuity
- coordinating delegated tasks and task notifications
- exposing the session API surface to the rest of the system

It is not responsible for:

- owning the actual Claude SDK runtime process
- owning the WebSocket client protocol
- ingesting transcript memory into SQLite

Those belong to the agent-host, gateway, and memory extension respectively.

## Core Model

There are three related but distinct concepts:

### 1. Draft session

A draft session is created by `session.create_session` and stored immediately in the session DB. It has a UUID and metadata, but it may not yet have a Claude JSONL transcript or active SDK runtime.

This makes session creation fast and avoids UI double-click races.

### 2. Materialized session

A materialized session exists once the agent-host has created or resumed the underlying Claude SDK session for that UUID.

Materialization happens lazily on first prompt.

### 3. Persistent session alias

Some callers use the sentinel `PERSISTENT_SESSION_ID`. The session extension resolves that alias to a real per-workspace session ID before continuing normal prompt flow.

## Create vs First Prompt

The most important lifecycle decision is that session creation is now intentionally cheap.

### Create session

`session.create_session` now does:

1. resolve or create workspace
2. generate session UUID
3. persist a draft session row
4. persist bootstrap metadata
5. set the workspace's active session
6. return immediately

It does not:

- call memory continuity APIs
- create the Claude SDK runtime
- inject memory context

### First prompt

The expensive bootstrapping work moved to `session.send_prompt`:

```text
send_prompt
  │
  ├─ resolve persistent alias if needed
  ├─ resolve workspace / stored session / effective cwd
  ├─ detect whether Claude session file/runtime exists
  ├─ if first real prompt:
  │    ├─ transition previous conversation
  │    ├─ fetch memory context
  │    ├─ build bootstrap system prompt
  │    └─ create Claude session using the pre-generated UUID
  ├─ attach request/stream context
  └─ dispatch prompt
```

This matches the actual cost profile better: "create" is instant, "send prompt" absorbs setup overhead while the user is already waiting for model output.

## Prompt Lifecycle

The prompt flow is implemented in [`extensions/session/src/lifecycle/prompt-lifecycle.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/prompt-lifecycle.ts).

It uses a prewired runner with three dependency groups:

- `session`: operations that apply to a draft or real session
- `request`: per-call envelope state like `connectionId`, `tags`, and request context maps
- `services`: config, logging, and prompt summarization helpers

### Prompt pipeline

```text
runPromptLifecycle(input, request)
  │
  ├─ resolveSessionStage
  │    resolve persistent alias
  │    load stored session
  │    infer cwd/workspace/model
  │
  ├─ prepareRuntimeStage
  │    ensure request context maps
  │    detect model drift
  │    recycle runtime if needed
  │
  ├─ bootstrapSessionStage
  │    if no Claude session exists yet:
  │      transition conversation
  │      load memory context
  │      create/resume session with explicit sessionId
  │
  ├─ attachRequestContextStage
  │    install primary/transient stream routing state
  │
  └─ dispatchPromptStage
       stream or await completion
```

### Why this matters

Before the refactor, prompt flow logic was spread across `index.ts`. Now the lifecycle is explicit, easier to reason about, and easier to evolve without turning `send_prompt` into an orchestration sink.

## Session Activation Lifecycle

Session switching and resetting have their own workflow runner in [`extensions/session/src/lifecycle/session-activation.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/session-activation.ts).

### Switch session

```text
switch_session
  │
  ├─ resolve/create workspace
  ├─ transition previous conversation in memory
  ├─ determine resume model
  ├─ recycle runtime if running model != desired model
  ├─ prompt empty string to lazily resume runtime
  ├─ upsert stored session
  └─ set workspace active session
```

### Reset session

```text
reset_session
  │
  ├─ resolve/create workspace
  ├─ capture previous active session
  ├─ transition previous conversation in memory
  ├─ create a fresh agent-host session
  ├─ persist new session with previousSessionId link
  └─ set workspace active session
```

These flows are related, but distinct from prompt dispatch, so they live in a separate runner.

## Query / Discovery Flow

Read-oriented session behavior lives in [`extensions/session/src/lifecycle/session-query.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/session-query.ts).

### Session discovery

Session discovery uses Claude's local project files under `~/.claude/projects`:

- [`extensions/session/src/claude-projects.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/claude-projects.ts) resolves the Claude project directory for a workspace
- it reads `sessions-index.json` when available
- it scans `.jsonl` transcript files as the primary source of truth
- it extracts the first prompt for lightweight session previews

This data is used to enrich the Anima session DB rather than replacing it.

### History and memory preview

- `session.get_history` reads paginated transcript history from Claude JSONL files
- `session.get_memory_context` previews the exact memory block that would be injected for a new session

Memory block formatting lives in [`extensions/session/src/memory-context.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/memory-context.ts).

## Event Bridges

The session extension has two important event bridges.

### Session event bridge

[`extensions/session/src/lifecycle/session-events.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/session-events.ts) adapts `agentClient` session events back into gateway events.

It is responsible for:

- restoring `connectionId` and `tags` for async stream events
- merging primary and transient tags correctly
- emitting session stream events through `ctx.emit`
- updating stored runtime status
- accumulating response text for non-streaming callers

This is necessary because async SDK events keep arriving after the original RPC call has returned, so the extension must preserve routing context explicitly.

### Task event bridge

[`extensions/session/src/lifecycle/task-events.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/task-events.ts) performs the same kind of adaptation for delegated tasks.

It handles:

- task event replay into the extension's in-memory task map
- state hydration from stored task sessions
- parent-session notifications on task completion
- `session.send_notification` wrapping via `<user_notification>` injection

## Task Workflow

Delegated task orchestration lives in [`extensions/session/src/lifecycle/task-workflow.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/task-workflow.ts).

The task model is intentionally session-centric:

- tasks are represented as child sessions in storage
- `parentSessionId` links the task back to the chat session
- task metadata stores prompt, cwd, git/worktree info, and output details

### Task lifecycle

```text
start_task
  │
  ├─ resolve parent session and cwd
  ├─ call agent-host TaskHost
  ├─ persist task as a child session
  ├─ cache in memory
  └─ return task handle

task.event
  │
  ├─ update in-memory task map
  ├─ persist runtime status / metadata
  └─ optionally notify parent session

list_tasks / get_task
  │
  └─ merge host task state with stored task sessions
```

This keeps task orchestration co-located instead of scattering task logic across multiple unrelated session methods.

## Method Dispatch

The session API surface is now split into two layers:

- [`extensions/session/src/session-methods.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-methods.ts): static Zod method definitions
- [`extensions/session/src/session-dispatch.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-dispatch.ts): method-to-workflow dispatch

`index.ts` keeps the logging/timing wrapper and extension bootstrap, but no longer owns the full method switch logic inline.

## Data Sources

The session system relies on four data sources:

### 1. Session DB

[`extensions/session/src/session-store.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-store.ts)

Stores:

- session metadata
- runtime status
- parent/previous session links
- task sessions
- workspace active session mapping

### 2. Workspace DB

[`extensions/session/src/workspace.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/workspace.ts)

Stores:

- workspace identity
- cwd
- general vs project-specific workspace scope

### 3. Claude project files

`~/.claude/projects/...`

Provides:

- transcript JSONL files
- `sessions-index.json`
- transcript-derived history and previews

### 4. Memory extension

Accessed through `ctx.call("memory.*")`.

Provides:

- `memory.transition_conversation`
- `memory.get_session_context`

The session extension consumes memory; it does not own the ingestion pipeline.

## Current File Map

### Extension shell

- [`extensions/session/src/index.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/index.ts)

### RPC surface

- [`extensions/session/src/session-methods.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-methods.ts)
- [`extensions/session/src/session-dispatch.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-dispatch.ts)

### Lifecycle workflows

- [`extensions/session/src/lifecycle/prompt-lifecycle.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/prompt-lifecycle.ts)
- [`extensions/session/src/lifecycle/session-activation.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/session-activation.ts)
- [`extensions/session/src/lifecycle/session-query.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/session-query.ts)
- [`extensions/session/src/lifecycle/session-events.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/session-events.ts)
- [`extensions/session/src/lifecycle/task-workflow.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/task-workflow.ts)
- [`extensions/session/src/lifecycle/task-events.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/lifecycle/task-events.ts)

### Storage and discovery

- [`extensions/session/src/session-store.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/session-store.ts)
- [`extensions/session/src/workspace.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/workspace.ts)
- [`extensions/session/src/claude-projects.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/claude-projects.ts)
- [`extensions/session/src/parse-session.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/parse-session.ts)
- [`extensions/session/src/memory-context.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/memory-context.ts)
- [`extensions/session/src/persistent-sessions.ts`](/Users/michael/Projects/iamclaudia-ai/anima/extensions/session/src/persistent-sessions.ts)

## Design Notes

### Why not public hooks?

The current lifecycle structure is internal on purpose.

We want:

- explicit stage ordering
- predictable error handling
- easy reasoning about side effects
- clean code organization

We do not want to prematurely create a general callback bus for core session behavior.

If public extensibility is added later, it should likely map onto Claude's own hook support where appropriate, with the internal lifecycle remaining the authoritative orchestration model.

### Why this refactor was worth it

The refactor increased the number of modules, but reduced the behavioral complexity of the system:

- create session is now honest and fast
- prompt bootstrap is explicit
- switch/reset/task/query flows have clear homes
- async event routing is no longer hidden inside `index.ts`
- the extension shell reads as composition rather than one giant control method

That is the right tradeoff for a foundational subsystem.
