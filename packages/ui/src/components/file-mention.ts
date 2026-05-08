/**
 * Utilities for detecting `@`-mentions inside the chat textarea.
 *
 * The picker should activate only when the `@` is preceded by whitespace, a
 * backtick, or BOF — so emails like `me@host.com` and continuations like
 * `path/to@file` don't trigger it.
 */

export interface ActiveMention {
  /** Index of the `@` character in the input. */
  triggerPos: number;
  /** Text between `@` and the cursor (exclusive). */
  query: string;
  /** Cursor position when this mention was detected. */
  cursorPos: number;
}

const TRIGGER_BOUNDARY_RE = /\s|`/;

/**
 * Walk backwards from the cursor looking for an `@` that starts a valid
 * mention. Returns null if there's no active mention at the cursor — this is
 * the "is the picker open?" predicate.
 *
 * Spaces are part of the query (the filter logic uses them for multi-token
 * AND search), so we only stop scanning at newlines. Invalid `@`s (those not
 * preceded by a boundary char — e.g. inside `me@host`) are skipped, so an
 * email later in the input doesn't kill an earlier valid mention.
 */
export function findActiveMention(input: string, cursorPos: number): ActiveMention | null {
  if (cursorPos < 0 || cursorPos > input.length) return null;

  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = input[i];
    // Newlines end any candidate mention — mentions can't span lines.
    if (ch === "\n" || ch === "\r") return null;
    if (ch === "@") {
      if (i === 0) {
        return { triggerPos: i, query: input.slice(i + 1, cursorPos), cursorPos };
      }
      const prev = input[i - 1];
      if (TRIGGER_BOUNDARY_RE.test(prev)) {
        return { triggerPos: i, query: input.slice(i + 1, cursorPos), cursorPos };
      }
      // Invalid boundary — keep scanning; there might be a valid `@` earlier.
    }
  }
  return null;
}

/**
 * Replace the active mention's `@<query>` segment with `@<path> ` and return
 * the new input + the cursor position where it should land afterward.
 *
 * Special case: when the character immediately before the `@` is a backtick,
 * the user is starting a markdown code span (`` `@path/to/file` ``), so we
 * append a closing backtick before the trailing space — saves them from
 * having to manually close the span.
 */
export function applyMentionSelection(
  input: string,
  mention: ActiveMention,
  selectedPath: string,
): { input: string; cursorPos: number } {
  const before = input.slice(0, mention.triggerPos);
  const after = input.slice(mention.triggerPos + 1 + mention.query.length);
  const inBacktickSpan = mention.triggerPos > 0 && input[mention.triggerPos - 1] === "`";
  const insertion = inBacktickSpan ? `@${selectedPath}\` ` : `@${selectedPath} `;
  return {
    input: before + insertion + after,
    cursorPos: before.length + insertion.length,
  };
}
