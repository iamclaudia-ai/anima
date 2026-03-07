# Session Provider Routing Plan

## Goal

Keep `chat` and `session` as separate extensions, but make `session` the canonical API for:

- workspace/session CRUD
- provider-aware prompt routing (`agent: claude | codex | gemini | ...`)
- provider-agnostic delegated tasks (`session.start_task` family)

`agent-host` becomes the sole owner of long-lived provider runtimes.

## Design Principles

1. Preserve extension boundaries:

- `chat`: UI/routes only.
- `session`: domain API and data model for conversations/workspaces/tasks.
- provider extensions (for now): optional compatibility shims / helper methods.

2. Runtime ownership stays in one place:

- `agent-host` owns provider drivers and process lifecycles.
- gateway/extensions do not own SDK process state.

3. API shape stays namespaced by extension:

- all canonical task APIs are `session.*`.
- provider-specific methods (`codex.review`) become aliases or skills over `session.start_task`.

4. Keep abstraction pragmatic:

- normalize only the transport and core lifecycle events.
- provider-specific capabilities can stay provider-scoped in task `metadata`.

## Target API (Session Extension)

### Conversation/session

- `session.create_session({ cwd, agent?, model?, systemPrompt?, thinking?, effort? })`
- `session.send_prompt({ sessionId, content, cwd?, agent?, streaming?, source? })`
- `session.get_info({ sessionId? })`
- existing workspace/history methods remain.

Notes:

- `agent` defaults from config (`session.agentDefault`, initially `claude`).
- For resumed sessions, `agent` is inferred from persisted session metadata unless explicitly overridden.

### Tasks

- `session.start_task({ sessionId, agent, prompt, cwd?, mode?, model?, effort?, metadata? })`
- `session.get_task({ taskId })`
- `session.list_tasks({ sessionId?, status? })`
- `session.interrupt_task({ taskId })`

Task mode examples:

- `general`
- `review`
- `test`

### Events

- Conversation stream continues on: `session.{sessionId}.*`
- Task stream standardized on: `session.task.{taskId}.*`

Core task events:

- `session.task.{taskId}.start`
- `session.task.{taskId}.delta`
- `session.task.{taskId}.item`
- `session.task.{taskId}.stop`
- `session.task.{taskId}.error`

Payload includes:

- `taskId`, `sessionId`, `agent`, `status`, `ts`
- provider-specific details in `metadata`.

## Agent Host Runtime Model

### Drivers

- `ClaudeDriver` for chat sessions.
- `CodexDriver` for delegated tasks (and later codex chat sessions if desired).
- `GeminiDriver` later without API break.

### Host-level contracts

- command namespace remains explicit:
  - `session.*` for chat/session runtime
  - `task.*` for delegated runtime
- shared protocol types live in `@claudia/shared`.

### Persistence

- session runtime registry (existing)
- task registry (new): task state, session linkage, provider, timestamps, output file pointers
- optional replay buffers per task for reconnect.

## Migration Phases

## Phase 1 (Now): Boundary cleanup and protocol stabilization

- Move agent-host protocol types into `@claudia/shared`.
- Remove cross-package source imports:
  - extensions should not import from `packages/agent-host/src/*`.
  - agent-host should not import from `extensions/*` long-term.
- Add `agent?` fields to session-facing method schemas and pass-through plumbing (claude default).

Deliverable:

- no source-path coupling for protocol types.

## Phase 2: Add session task API in session extension (compat adapter)

- Add `session.start_task/get_task/list_tasks/interrupt_task`.
- Temporary implementation can call existing `codex.*` methods internally for `agent=codex` while host task runtime is being built.
- Emit/forward standardized `session.task.*` events.

Deliverable:

- callers can stop using `codex.*` directly.

## Phase 3: Move Codex runtime into agent-host

- Implement `TaskHost` + `CodexDriver` in agent-host.
- Extend host protocol with `task.start/get/list/interrupt` + `task.event`.
- Convert `session.start_task` to call agent-host task APIs.
- Keep `codex.*` as alias wrappers (or deprecate after skill rollout).

Deliverable:

- codex tasks survive gateway/extension restarts.

## Phase 4: Multi-provider chat sessions

- persist `agent` on session records.
- agent-host `session.create/prompt` routes by session agent.
- add additional driver(s), e.g. `GeminiDriver`.

Deliverable:

- same `session.*` API for all chat providers.

## Compatibility and Rollout

- No strict backward-compat requirement, but minimize operator pain:
  - keep `codex.*` for now as wrappers.
  - update docs + skill guidance to use `session.start_task`.
- health check should include:
  - active sessions by agent
  - active tasks by agent/status

## Testing Strategy

1. unit:

- schema validation for new session methods
- event name normalization (`codex.*` -> `session.task.*` adapter)

2. integration:

- `session.start_task(agent=codex)` returns `taskId`
- progress events reach caller-scoped connection
- interrupt transitions status deterministically

3. migration safety:

- existing `session.send_prompt` Claude path unchanged by default
- existing `codex.*` still functional while adapters exist
