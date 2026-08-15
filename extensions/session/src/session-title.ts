/**
 * Session title derivation.
 *
 * The nav used to render a session's raw first user message, which is wrong
 * for any session started with a slash command: Claude Code expands those into
 * an envelope, so the list showed `<command-message>…` for every skill-launched
 * session — exactly the long-running PR reviews worth returning to.
 *
 * Everything here is pure so it can be unit-tested against real transcript
 * shapes. A stored title (set explicitly by the user) always wins over a
 * derived one; this is only the fallback.
 */

import { truncatePreservingSurrogates } from "@anima/shared";

/** Max length of a derived title. Longer titles just get truncated in the nav. */
const TITLE_MAX_LENGTH = 120;

/** How many leading user messages to consider before giving up. */
const MAX_MESSAGES_SCANNED = 10;

/**
 * Wrapper tags Claude Code injects around non-prose content. These are
 * standalone messages or blocks that carry no user intent, so they're removed
 * outright — content and all — rather than unwrapped.
 */
const ENVELOPE_TAGS = [
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "system-reminder",
  "command-message",
];

/**
 * Extract the content of a single XML-ish tag. Claude Code emits these with
 * inconsistent ordering and indentation between versions, so this matches by
 * name rather than position. `[^]` matches across newlines (`.` does not).
 */
function tagContent(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^]*?)</${tag}>`, "i").exec(text);
  return match?.[1]?.trim() ?? null;
}

/** Remove envelope tags and their contents entirely. */
function stripEnvelopes(text: string): string {
  let out = text;
  for (const tag of ENVELOPE_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[^]*?</${tag}>`, "gi"), " ");
    // Unclosed variant — a truncated read can cut mid-tag.
    out = out.replace(new RegExp(`<${tag}>[^]*$`, "i"), " ");
  }
  return out;
}

/** Collapse whitespace and trim to a single display line. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Derive a title from one user message's text, or null if it carries no
 * usable intent (pure envelope, empty, or attachment-only).
 */
export function deriveTitleFromMessage(raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;

  // Slash command: title from the command plus its arguments, which is what
  // the user actually typed. `/reviewing-prs-with-claudia 28212 can you…`
  const commandName = tagContent(raw, "command-name");
  if (commandName) {
    const args = normalize(stripEnvelopes(tagContent(raw, "command-args") ?? ""));
    const title = normalize(`${commandName} ${args}`);
    return title ? truncatePreservingSurrogates(title, TITLE_MAX_LENGTH) : null;
  }

  let text = stripEnvelopes(raw);

  // Drop attachment markers (`[Image #1]`) that prefix an otherwise normal
  // prompt — they're noise in a list, and a title of "[Image #1]" is useless.
  text = text.replace(/\[(?:Image|Screenshot|Pasted text) #\d+\]/gi, " ");

  const normalized = normalize(text);
  if (!normalized) return null;

  // Anything still leading with a tag is markup we don't recognize. Better to
  // fall through to the next message than to render angle brackets in the nav.
  if (normalized.startsWith("<")) return null;

  return truncatePreservingSurrogates(normalized, TITLE_MAX_LENGTH);
}

/**
 * Derive a session title from its leading user messages, in transcript order.
 *
 * Walks forward past envelope-only messages (a standalone
 * `<local-command-caveat>` is the common one) to the first message carrying
 * real intent. Returns null when nothing usable is found, so the caller can
 * fall back to a session-id label rather than showing markup.
 */
export function deriveSessionTitle(userMessageTexts: readonly string[]): string | null {
  for (const raw of userMessageTexts.slice(0, MAX_MESSAGES_SCANNED)) {
    const title = deriveTitleFromMessage(raw);
    if (title) return title;
  }
  return null;
}
