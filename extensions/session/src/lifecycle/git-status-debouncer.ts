/**
 * Debounced git_status emitter for mutating tool calls.
 *
 * Mid-turn the user wants to see git state evolve. We watch `tool_use`
 * blocks for whitelisted mutating tools, then when their `tool_result`
 * comes back we schedule a trailing-debounced git_status emit per session.
 * Coalesces bursts of edits and rides through long Bash by virtue of
 * hooking the result (post-execution), not the call.
 */

import { getStoredSession } from "../session-store";
import { emitGitStatus } from "./session-events";

const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
const DEFAULT_DEBOUNCE_MS = 500;

interface SessionDebounceState {
  pendingToolUseIds: Map<string, string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const state = new Map<string, SessionDebounceState>();
let debounceMs = DEFAULT_DEBOUNCE_MS;

/** Test-only: override the debounce interval. */
export function setGitStatusDebounceMs(ms: number): void {
  debounceMs = ms;
}

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

function getState(sessionId: string): SessionDebounceState {
  let s = state.get(sessionId);
  if (!s) {
    s = { pendingToolUseIds: new Map(), timer: null };
    state.set(sessionId, s);
  }
  return s;
}

/** Record a tool_use block start. No-op for non-mutating tools. */
export function noteToolUseStart(sessionId: string, toolUseId: string, toolName: string): void {
  if (!MUTATING_TOOLS.has(toolName)) return;
  getState(sessionId).pendingToolUseIds.set(toolUseId, toolName);
}

/**
 * Record a tool_result. Schedules a debounced emit on this session — and
 * on the parent session too if this is a subagent — but only if the result
 * matches a previously-tracked mutating tool_use.
 */
export function noteToolResult(sessionId: string, toolUseId: string): void {
  const s = state.get(sessionId);
  if (!s || !s.pendingToolUseIds.has(toolUseId)) return;
  s.pendingToolUseIds.delete(toolUseId);
  scheduleEmit(sessionId);

  const stored = getStoredSession(sessionId);
  if (stored?.parentSessionId) {
    scheduleEmit(stored.parentSessionId);
  }
}

function scheduleEmit(sessionId: string): void {
  const s = getState(sessionId);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void emitGitStatus(sessionId);
  }, debounceMs);
}

/**
 * Cancel a pending debounced emit. Called on turn_stop so the existing
 * unconditional emit there doesn't double-fire on top of the debounced one.
 */
export function cancelPendingGitStatus(sessionId: string): void {
  const s = state.get(sessionId);
  if (!s) return;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.pendingToolUseIds.clear();
}

/** Drop all tracking for a session (close / cleanup). */
export function dropGitStatusDebounce(sessionId: string): void {
  const s = state.get(sessionId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  state.delete(sessionId);
}
