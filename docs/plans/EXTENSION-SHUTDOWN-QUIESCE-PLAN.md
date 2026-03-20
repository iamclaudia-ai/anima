# Extension Shutdown + Quiesce Plan

Date saved: 2026-03-06

## Goal

Improve extension HMR/restart lifecycle safety only if needed, without over-complicating the baseline architecture.

Current policy remains:

- Singleton process lifecycle is standardized at gateway level.
- Extension-specific cleanup remains extension-owned via `stop()`.

## 1. Lifecycle Contract (Docs First)

1. Add a "Shutdown Guarantees" section to extension docs.
2. Require `stop()` to fully clean up:
   - active streams/sockets
   - timers/intervals
   - child processes
   - pending async queues
   - event subscriptions
3. Require `stop()` to be idempotent and safe under HMR/restart/crash-recovery paths.

## 2. Optional Host Quiesce Mode (Future)

1. Add an optional quiesce mode in extension host lifecycle.
2. In quiesce mode:
   - old generation receives `stop()`
   - gateway drops old-generation events (already implemented)
   - new registration is delayed until old stop promise resolves (or timeout)
3. Keep quiesce disabled by default initially.

## 3. Diagnostics (If Needed)

1. Add per-extension lifecycle log markers:
   - `stop.start`
   - `stop.complete`
   - `stop.timeout`
2. Add shutdown duration metric to health details (optional).
3. Emit warning when stop duration exceeds threshold (e.g., 2s).

## 4. Test Coverage (If Implemented)

1. Host test: old-generation event emitted after stop/start boundary is dropped.
2. Fixture test: delayed `stop()` blocks new registration when quiesce mode is enabled.
3. Regression test: no duplicate stream emissions across HMR boundaries.

## 5. Rollout Strategy

1. Phase 1 (now): docs + extension-owned cleanup only.
2. Phase 2: enable quiesce mode for one extension (voice) if duplication issues continue.
3. Phase 3: consider default quiesce for all extensions only if proven valuable.

## Decision Notes

- Do not add user-facing `*.shutdown` methods right now.
- Keep lifecycle shutdown internal to host/extension runtime.
- Reassess only if duplicate behavior persists in real usage.
