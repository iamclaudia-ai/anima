# Agent Host / Session / Codex Review

## What Exists Today

### Process model

- `watchdog` supervises `agent-host` and `gateway` as sibling services.
- `session` extension talks to `agent-host` over WebSocket.
- `codex` extension still runs Codex SDK directly inside the extension process.

### Ownership boundaries in code (actual)

- `session` extension is already a thin client for runtime operations (`create/prompt/interrupt/close/tool_result`) via `AgentHostClient`.
- `session` extension still owns workspace/session indexing and transcript/history parsing from `~/.claude/projects`.
- `codex` extension owns Codex SDK lifecycle, task streaming, and completion notifications to session.
- `agent-host` only supports session RPC/events (no codex RPC/events yet).

## Current Coupling Problems

1. `agent-host` imports from `extensions/session` (backwards dependency).

- `packages/agent-host/src/session-host.ts:23` imports `../../../extensions/session/src/sdk-session`.
- This means runtime host depends on extension implementation details.

2. `session` extension imports protocol types from `agent-host` source path.

- `extensions/session/src/agent-client.ts:24` imports `../../../packages/agent-host/src/protocol`.
- This couples extension build/runtime to service source layout.

3. Codex lifecycle is not isolated from gateway/extension restarts.

- `extensions/codex/src/index.ts:9-10` documents Codex process under extension host.
- `extensions/codex/src/index.ts:210-229` initializes SDK in extension.
- `extensions/codex/src/index.ts:611-691` runs tasks in extension memory/background.
- So gateway/extension restart can terminate active Codex tasks.

4. Claimed architecture and implemented architecture diverge.

- `docs/ARCHITECTURE.md:11` says agent-host owns Claude + Codex SDK processes.
- `packages/agent-host/src/protocol.ts:18-87` defines only session messages.
- `packages/agent-host/package.json:11-15` has no Codex SDK dependency.
- `extensions/codex/package.json:11-15` has Codex SDK dependency.

5. Runtime protocol is session-specific, not engine-agnostic.

- Message names are `session.*` only in `packages/agent-host/src/protocol.ts`.
- This makes adding multiple engines awkward and leaks Claude naming into host contract.

## Recommendation (Target Architecture)

### Decision

Keep **separate gateway extensions** (`session`, `codex`) but move **all SDK runtime ownership** into `agent-host`.

Why:

- Preserves clear product/API surfaces (`session.*` chat lifecycle vs `codex.*` delegated tasks).
- Avoids exploding `session.send_prompt` into mixed semantics (`agent=claude|codex`) that blur UX and contracts.
- Lets Codex evolve independently (task-specific methods/events remain appropriate).

### Target boundaries

- `agent-host`: owns all long-lived SDK/CLI runtime state and process lifecycles.
  - Claude session runtime
  - Codex task runtime
  - Event buffers + reconnect replay
- `session` extension: workspace/session metadata + transcript parsing + routing contexts + thin RPC.
- `codex` extension: method schemas + prompt shaping/preambles + thin RPC + UI-facing event mapping.
- `shared` package: canonical agent-host protocol/types used by both `agent-host` and extensions.

### Protocol direction

Introduce a shared protocol module in `@claudia/shared`:

- `agentHost.session.*` commands/events (current behavior)
- `agentHost.codex.*` commands/events (new)

Do not import protocol types cross-package via relative source paths.

### Engine abstraction in agent-host

Add host-internal drivers:

- `ClaudeDriver` (current SessionHost runtime)
- `CodexDriver` (new runtime for codex tasks)

Both expose a normalized internal interface:

- `start`
- `send/prompt`
- `interrupt`
- `close/status`
- event stream with sequence numbers

The gateway-facing API can remain namespaced (`session.*`, `codex.*`) even if internals are normalized.

## Should `session.send_prompt` get `agent: claude | codex`?

Recommendation: **No**, not as the primary model.

Use:

- `session.*` for main chat Claude workflow.
- `codex.*` for delegated sub-agent workflows.

Reason:

- Different lifecycle semantics (multi-turn chat session vs bounded delegated task).
- Different output/event shapes.
- Better observability and health reporting per extension.

If needed later, add a convenience orchestration method (for example `agent.delegate`) that internally calls `codex.task`, but keep core APIs separated.

## Proposed Migration Plan

### Phase 1: Untangle package boundaries (low risk)

1. Move `sdk-session.ts` + related Claude runtime primitives into `packages/agent-host/src/claude/` (or shared runtime package).
2. Move agent-host protocol types into `packages/shared/src/agent-host-protocol.ts`.
3. Update `session` extension and `agent-host` to import protocol from `@claudia/shared`.

Outcome:

- No `agent-host -> extensions/*` imports.
- No `extensions/* -> packages/agent-host/src/*` imports.

### Phase 2: Add Codex runtime to agent-host

1. Add `CodexHost` in `packages/agent-host`:

- owns Codex SDK initialization
- supports one-or-more tasks with explicit concurrency policy
- emits `codex.event` with seq numbers for replay

2. Extend host protocol with:

- `codex.start` / `codex.interrupt` / `codex.status` (and optional `codex.list`)
- `codex.event` stream messages

3. Persist codex task metadata as needed for reconnect/status.

Outcome:

- Codex tasks survive gateway/extension restarts similarly to Claude sessions.

### Phase 3: Convert codex extension to thin client

1. Replace direct `@openai/codex-sdk` usage in `extensions/codex`.
2. Add `CodexAgentClient` similar to `AgentHostClient`.
3. Keep codex extension method schemas and UX-facing event names stable.
4. Optionally move `session.send_notification` side effect to agent-host if you want host-level orchestration.

Outcome:

- Codex extension mirrors session extension architecture.

### Phase 4: Clarify docs and contracts

1. Update `docs/ARCHITECTURE.md` to match implemented state and post-migration target.
2. Add explicit boundary rules:

- `agent-host` must not import from `extensions/*`.
- extensions must not import from `packages/agent-host/src/*`.

3. Add contract tests for protocol compatibility.

## Additional Notes

- Session context routing (`connectionId`, tags, primary/transient context merging) is extension/UI-facing behavior and should stay in the `session` extension.
- Workspace CRUD and transcript parsing should stay out of `agent-host` unless you intentionally want a monolithic runtime service.
- Codex currently enforces a single active task in-memory (`extensions/codex/src/index.ts:623`), which is fine short-term but should become an explicit host-level concurrency policy when migrated.
