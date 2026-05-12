/**
 * Memory extension configuration shape.
 *
 * Lifted out of `index.ts` so that sibling modules (state-machine, etc.) can
 * reference the type without a barrel-style `import from "./index"` that
 * forms a circular reference.
 */

export interface MemoryConfig {
  /** Base directory to watch for JSONL sessions (default: ~/.claude/projects) */
  watchPath?: string;
  /** Enable file watching + startup scan (default: true) */
  watch?: boolean;
  /** Minutes of silence before a conversation is considered "done" (default: 60) */
  conversationGapMinutes?: number;
  /** Minimum messages in a conversation for Libby to process it (default: 5) */
  minConversationMessages?: number;
  /** Timezone for Libby's transcript formatting (default: America/New_York) */
  timezone?: string;
  /** Model for Libby to use via session.send_prompt (default: claude-sonnet-4-6) */
  model?: string;
  /** Max conversations per memory.process invocation (default: 10) */
  processBatchSize?: number;
  /** Auto-process ready conversations on poll timer (default: false) */
  autoProcess?: boolean;
  /**
   * File exclusion patterns for ingestion.
   * Absolute patterns (`/` or `~`) match absolute watched file paths.
   * Relative patterns match the computed file key under watchPath.
   */
  exclude?: string[];
}
