# Codex Session Ingestion Plan (for Libby)

Date saved: 2026-03-06

## Goal

Import Codex conversations into the memory system as a separate source so Claudia can search them, while preserving identity boundaries:

- Claudia-origin memories remain first-person Claudia.
- Codex-origin memories are summarized in third person as "Michael and Cody...".

## 1. Add source config for Codex ingestion

1. Add additive config block for Codex in memory extension settings.
2. Default state: enabled `false` for initial rollout safety.
3. Default probe path: `~/.codex/sessions`.
4. Keep existing path resolution behavior:
   - If path starts with `~` or `/`, treat as absolute.
   - Otherwise resolve relative to current working directory.
5. Add optional exclude patterns, consistent with existing ingestion excludes.

## 2. Build Codex JSONL ingestor

1. Add Codex-specific parser for `rollout-*.jsonl` files under date folders.
2. Parse line schema: `{ timestamp, type, payload }`.
3. Ingest canonical turn events only for v1:
   - `event_msg.user_message` -> role `user`
   - `event_msg.agent_message` -> role `assistant`
4. Ignore telemetry/noise events in v1 (`token_count`, `task_*`, etc.).
5. Pull `session_id` and fallback `cwd` from `session_meta.payload`.

## 3. Conversation linking and idempotency

1. Conversation identity key: `source=codex + session_id + source_file`.
2. Reuse high-water-mark resume model.
3. Add deterministic entry fingerprinting for Codex lines:
   - `timestamp + role + normalized content hash`
4. Ensure replay/restart does not create duplicate rows.
5. Keep partial-processing recovery semantics unchanged.

## 4. Speaker/source semantics for Libby

1. Tag Codex conversations with assistant identity `Cody`.
2. Update transcript formatter for Codex source to render `Michael` and `Cody`.
3. Update Libby system prompt rules:
   - Codex-source summaries must be third person.
   - Use phrasing like "Michael and Cody ...".
   - Never convert Codex conversations into Claudia first-person memories.
4. Preserve current Claudia behavior for Claude-source conversations.

## 5. Processing controls and safety

1. Keep ingestion and processing toggles separable (start ingest-only).
2. Apply excludes at ingestion-time and processing-time.
3. Reuse single-runner guardrails and include Codex in health-check visibility.

## 6. Tests

1. Parser unit tests with fixture lines:
   - `session_meta`
   - `event_msg.user_message`
   - `event_msg.agent_message`
   - ignored telemetry/noise
2. Dedup/idempotency restart/replay tests.
3. Formatter tests for `Cody` naming path.
4. Prompt-routing tests to ensure Codex source uses third person.
5. Integration test: ingest sample Codex rollout -> conversation rows -> queue payload.

## 7. Rollout strategy

1. Phase 1: ship ingest-only for Codex, run backfill, validate counts and duplicates.
2. Phase 2: process a small batch (5-10), review memory quality and source labeling.
3. Phase 3: enable realtime watch + processing for Codex source.

## Notes from research

- Codex transcript storage location: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- `~/.codex/history.jsonl` is useful as an index/history, not a full transcript source.
- SDK types can guide schema handling, but persisted rollout parsing should be implemented in the memory extension.
