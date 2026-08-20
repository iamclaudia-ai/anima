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

/**
 * Runtime status for a modal-prompt event (#69), which is the only thing that
 * writes the two attention states.
 *
 * Kept out of {@link toRuntimeStatusFromSessionEvent} for the same reason
 * `turn_stop` is: these events carry metadata that must be written in the same
 * transition as the status, so their handler owns the write rather than the
 * generic mapper doing half of it first.
 *
 * Which state depends on what is being asked — a hook confirmation gating a
 * tool call is an approval, the folder-trust dialog is input. Where a *cleared*
 * modal lands depends on whether a turn was waiting behind it: answering a hook
 * confirmation resumes the tool call, while dismissing a trust dialog at launch
 * just returns to idle.
 */
export function toRuntimeStatusFromModalEvent(
  type: string,
  payload: Record<string, unknown>,
): RuntimeStatus | null {
  if (type === "modal_prompt") {
    return payload.kind === "approval" ? "awaiting_approval" : "awaiting_input";
  }
  if (type === "modal_prompt_cleared") {
    return payload.resumedTurn === true ? "running" : "idle";
  }
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

/**
 * The user-visible text of a prompt, whatever shape it arrived in.
 *
 * A prompt from the web UI is an array of blocks — text, images, files — and
 * only the text ones say anything about what the turn is *for*. Joined rather
 * than first-only: a pasted screenshot followed by "fix this" would otherwise
 * yield nothing.
 */
export function promptText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}
