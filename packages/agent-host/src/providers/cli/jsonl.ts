/**
 * Pure helpers for reading the Claude Code session JSONL transcript the CLI
 * writes for our own session.
 *
 * The tee proxy sees the model's SSE stream, but several runtime signals never
 * appear on the wire (or in any hook) — they only land in this transcript:
 *   - prompt receipt        `type:"user"` ‖ `queue-operation/enqueue`
 *   - steer landing         `dequeue` (promoted to a new turn) vs `remove` (injected in-turn)
 *   - interrupt + turn-end  `[Request interrupted by user…]` (no SSE, no hook fires)
 *
 * This module is the shared parse layer: a resolver for our own session file and
 * a line classifier. Dependency-free so both the agent-host tail (low-latency,
 * one file) and any future ingester can reuse one parse implementation.
 *
 * Verified against real transcripts (CLI v2.1.156):
 *   {"type":"queue-operation","operation":"enqueue","content":"…","sessionId":…}
 *   {"type":"queue-operation","operation":"dequeue",…}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text",
 *     "text":"[Request interrupted by user for tool use]"}]},
 *     "interruptedMessageId":"msg_…",…}
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code encodes a cwd into its project dir by replacing `/` and `.` with `-`. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Absolute path to our own session's JSONL transcript. Tries the canonical
 * encoding, then the legacy `/`-only form, and falls back to the canonical path
 * even when it doesn't exist yet (the CLI creates it lazily on the first prompt;
 * a tail can poll for it to appear).
 */
export function resolveOwnSessionPath(cwd: string, sessionId: string): string {
  const projectsDir = join(homedir(), ".claude", "projects");
  const canonical = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(canonical)) return canonical;
  const legacy = join(projectsDir, cwd.replace(/\//g, "-"), `${sessionId}.jsonl`);
  if (legacy !== canonical && existsSync(legacy)) return legacy;
  return canonical;
}

export type ClaudeEntry =
  | { kind: "user_prompt"; text: string; timestamp?: string }
  | { kind: "interrupt"; forToolUse: boolean; timestamp?: string }
  | { kind: "enqueue"; content: string; timestamp?: string }
  | { kind: "dequeue"; timestamp?: string }
  | { kind: "remove"; timestamp?: string }
  | { kind: "other" };

const INTERRUPT_RE = /^\[Request interrupted by user/;

/** Flatten a JSONL user message's `content` (string or block array) to text. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
      parts.push(String((b as Record<string, unknown>).text ?? ""));
    }
  }
  return parts.join("\n");
}

/** Does a user message carry any tool_result block (a continuation, not a prompt)? */
function hasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
    )
  );
}

/**
 * Classify one JSONL line. Returns null for blank/unparseable lines so a tail
 * can carry a partial trailing line across reads without emitting noise.
 *
 * Note `type:"user"` covers three distinct things — a real prompt, an interrupt
 * marker, and a tool_result continuation — disambiguated here so callers get a
 * single clean signal each.
 */
export function classifyEntry(line: string): ClaudeEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = e.type;
  const timestamp = typeof e.timestamp === "string" ? e.timestamp : undefined;

  if (type === "queue-operation") {
    const op = e.operation;
    if (op === "enqueue") {
      return {
        kind: "enqueue",
        content: typeof e.content === "string" ? e.content : "",
        timestamp,
      };
    }
    if (op === "dequeue") return { kind: "dequeue", timestamp };
    if (op === "remove") return { kind: "remove", timestamp };
    return { kind: "other" };
  }

  if (type === "user") {
    const msg = (e.message ?? {}) as Record<string, unknown>;
    const text = userText(msg.content);
    // Interrupt markers are `type:"user"` too — distinguished by the marker text
    // and/or an `interruptedMessageId` field the CLI stamps on them.
    if (e.interruptedMessageId !== undefined || INTERRUPT_RE.test(text)) {
      return { kind: "interrupt", forToolUse: /for tool use/i.test(text), timestamp };
    }
    if (hasToolResult(msg.content)) return { kind: "other" };
    return { kind: "user_prompt", text, timestamp };
  }

  return { kind: "other" };
}
