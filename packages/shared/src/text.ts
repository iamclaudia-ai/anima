/**
 * Text utilities shared across the monorepo.
 */

/**
 * Truncate a string to at most `max` UTF-16 code units without splitting a
 * surrogate pair. Astral-plane characters (emojis like 💙, 📚, 🥰) are stored
 * as two code units in JS strings; a naive `slice(0, max)` can leave a lone
 * high surrogate, which JSON-encodes as `\uD8XX` with no low partner and is
 * rejected by strict JSON parsers (e.g. the one Anthropic's API uses,
 * producing: "no low surrogate in string").
 *
 * When truncation occurs, `ellipsis` is appended (so the result can be up to
 * `max + ellipsis.length` code units long). Strings at or under `max` are
 * returned unchanged.
 */
export function truncatePreservingSurrogates(str: string, max: number, ellipsis = "..."): string {
  if (str.length <= max) return str;
  let end = max;
  const lastCodeUnit = str.charCodeAt(end - 1);
  // If the slice would end on a high surrogate, drop it so we only emit
  // complete code points.
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return str.slice(0, end) + ellipsis;
}
