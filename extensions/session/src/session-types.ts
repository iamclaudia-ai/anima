/**
 * Shared types and helpers for the session extension.
 *
 * These are the canonical type definitions used across all session
 * lifecycle modules. Modules import these directly instead of defining
 * their own "*Like" interfaces.
 */

import type { RuntimeStatus } from "./session-store";

// ── Types ────────────────────────────────────────────────────

export interface AgentHostSessionInfo {
  id: string;
  cwd: string;
  model: string;
  isActive: boolean;
  isProcessRunning: boolean;
  createdAt: string;
  lastActivity: string;
  healthy: boolean;
  stale: boolean;
}

export interface SessionRuntimeConfig {
  model: string;
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  systemPrompt: string | null;
}

export interface RequestContext {
  connectionId: string | null;
  tags: string[] | null;
  source?: string;
  responseText: string;
}

// ── Pure helpers ─────────────────────────────────────────────

/**
 * Merge tags from a primary (streaming) context and the current transient context.
 * The primary context's tags are authoritative — e.g., voice.speak from the web UI
 * should persist even when a CLI command or notification temporarily overrides
 * the requestContext for routing purposes.
 */
export function mergeTags(primary: string[] | null, current: string[] | null): string[] | null {
  if (!primary && !current) return null;
  if (!primary) return current;
  if (!current) return primary;
  const merged = new Set([...primary, ...current]);
  return Array.from(merged);
}

/**
 * Map an agent-host session event type to a RuntimeStatus.
 *
 * `turn_stop` is deliberately absent. Its own handler writes `completed`
 * along with the turn's metadata, so mapping it here too meant every turn end
 * wrote `idle` and then overwrote it with `completed` a few lines later. That
 * was merely wasteful while the write was silent; now that a status write
 * announces itself on the bus, it would be two events per turn describing one
 * transition.
 */
export function toRuntimeStatusFromSessionEvent(type: string): RuntimeStatus | null {
  if (type === "process_started") return "running";
  if (type === "process_ended") return "idle";
  return null;
}

/** Summarize prompt shape for logging without storing user content. */
export function summarizePrompt(content: string | unknown[]): Record<string, unknown> {
  if (typeof content === "string") {
    return { kind: "text", chars: content.length };
  }

  const blocks = content as Array<Record<string, unknown>>;
  let textBlocks = 0;
  let imageBlocks = 0;
  let otherBlocks = 0;

  for (const block of blocks) {
    if (block?.type === "text") textBlocks++;
    else if (block?.type === "image") imageBlocks++;
    else otherBlocks++;
  }

  return { kind: "blocks", blocks: blocks.length, textBlocks, imageBlocks, otherBlocks };
}
