/**
 * Extract issue / PR / ticket references from session text.
 *
 * These are rendered as chips under each session title, so the nav answers
 * "which session was the #28388 work?" without opening anything — and they
 * become exact-match filters for search.
 *
 * Because a false positive is now visible clutter on every row, matching is
 * deliberately conservative and **configuration-driven**. A generic
 * `/[A-Z]+-\d+/` looks reasonable until you run it over real transcripts:
 *
 *   WEB-5592 ✓   BEE-24118 ✓   ENT-812 ✓
 *   UTF-8 ✗   SHA-256 ✗   RFC-2119 ✗   GMT-4 ✗   GPT-4 ✗   HDMI-2 ✗
 *   Z0-9 ✗ (from a regex character class)   A98C-4 ✗ (from a UUID)
 *
 * Every one of those false positives was measured in this workspace's own
 * history, so the allowed ticket prefixes come from `anima.json` rather than a
 * pattern that tries to guess.
 */

export type SessionRefType = "github" | "linear";

export interface SessionRef {
  type: SessionRefType;
  /** Canonical, de-duplicated identity — e.g. `owner/repo#123` or `BEE-24118`. */
  key: string;
  /** What the chip shows — e.g. `#123` or `BEE-24118`. */
  label: string;
  /** Link target, when enough configuration exists to build one. */
  url?: string;
}

export interface RefsConfig {
  linear?: {
    /** Allowed ticket prefixes. Nothing matches when this is empty. */
    prefixes?: string[];
    /** Linear workspace slug, used to build issue URLs. */
    workspace?: string;
  };
  github?: {
    /** `owner/repo` used to resolve bare `#123` references. */
    defaultRepo?: string;
    /**
     * Minimum digits for a bare `#N` to count. Prose is full of "#1 priority"
     * and "#2 on the list"; real PR numbers are rarely single-digit.
     */
    minDigits?: number;
  };
}

const DEFAULT_MIN_DIGITS = 2;

/** `owner/repo#123` — an explicit repo always wins over the default. */
const QUALIFIED_PR = /\b([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g;

/**
 * A bare `#123`.
 *
 * Requires a non-word character before the `#` so `abc#12` (already handled as
 * qualified) and colour-like tokens don't match, and rejects a trailing word
 * character so `#12abc` is skipped.
 */
const BARE_PR = /(^|[^\w/])#(\d+)(?![\w-])/g;

/**
 * A number passed as the first argument to a slash command — `/review 28388`.
 *
 * Skill-launched sessions are exactly the ones worth finding again, and they
 * name their PR as a bare argument with no `#`. A bare number anywhere in prose
 * would be far too noisy (dates, counts, versions), so this is anchored to the
 * start of a command invocation, where the convention is unambiguous.
 */
const COMMAND_ARG_PR = /^\/[\w-]+\s+#?(\d{2,7})\b/;

/**
 * Claude Code's own placeholder for a pasted screenshot — `[Image #9]`.
 *
 * Not user prose at all, but it matches a bare `#N` perfectly, and it was the
 * single largest source of false positives once extraction started reading
 * whole conversations: 204 hits across 30 days, second only to genuine `PR #N`
 * mentions. Michael pastes screenshots constantly, so this would have put a
 * bogus chip on a large share of rows.
 *
 * Matched against the text immediately preceding the `#`, so the bracket being
 * present or absent doesn't matter.
 */
const IMAGE_PLACEHOLDER = /\bimage\s*$/i;

function githubUrl(repo: string | undefined, number: string): string | undefined {
  return repo ? `https://github.com/${repo}/issues/${number}` : undefined;
}

function linearUrl(workspace: string | undefined, key: string): string | undefined {
  return workspace ? `https://linear.app/${workspace}/issue/${key}` : undefined;
}

/**
 * Extract references from a block of text.
 *
 * Returns them de-duplicated by `key`, in first-seen order — the order a
 * session's chips should read in.
 */
export function extractRefs(text: string, config: RefsConfig = {}): SessionRef[] {
  if (!text) return [];

  const found = new Map<string, SessionRef>();
  const add = (ref: SessionRef): void => {
    if (!found.has(ref.key)) found.set(ref.key, ref);
  };

  const defaultRepo = config.github?.defaultRepo;
  const minDigits = config.github?.minDigits ?? DEFAULT_MIN_DIGITS;

  for (const match of text.matchAll(QUALIFIED_PR)) {
    const [, repo, number] = match;
    if (!repo || !number) continue;
    add({
      type: "github",
      key: `${repo}#${number}`,
      label: `${repo}#${number}`,
      url: githubUrl(repo, number),
    });
  }

  // Checked before the bare-`#` pass so a command's own argument is the first
  // chip on the row — it's the subject of the session, not an aside.
  const commandArg = COMMAND_ARG_PR.exec(text.trimStart());
  if (commandArg?.[1] && commandArg[1].length >= minDigits) {
    const number = commandArg[1];
    add({
      type: "github",
      key: defaultRepo ? `${defaultRepo}#${number}` : `#${number}`,
      label: `#${number}`,
      url: githubUrl(defaultRepo, number),
    });
  }

  for (const match of text.matchAll(BARE_PR)) {
    const number = match[2];
    if (!number || number.length < minDigits) continue;
    const start = match.index ?? 0;
    const preceding = text.slice(Math.max(0, start - 24), start + (match[1]?.length ?? 0));
    if (IMAGE_PLACEHOLDER.test(preceding)) continue;
    // A bare number in a workspace with a known repo is that repo's issue;
    // without one we still show the chip, just unlinked.
    const key = defaultRepo ? `${defaultRepo}#${number}` : `#${number}`;
    add({ type: "github", key, label: `#${number}`, url: githubUrl(defaultRepo, number) });
  }

  const prefixes = (config.linear?.prefixes ?? []).filter(Boolean);
  if (prefixes.length > 0) {
    // Anchored to the configured prefixes, which is the whole point — see the
    // false positives in the module comment.
    const pattern = new RegExp(`\\b(${prefixes.join("|")})-(\\d{1,6})\\b`, "g");
    for (const match of text.matchAll(pattern)) {
      const [, prefix, number] = match;
      if (!prefix || !number) continue;
      const key = `${prefix}-${number}`;
      add({ type: "linear", key, label: key, url: linearUrl(config.linear?.workspace, key) });
    }
  }

  return [...found.values()];
}

/** Extract across several texts, preserving first-seen order and de-duping. */
export function extractRefsFromTexts(
  texts: readonly string[],
  config: RefsConfig = {},
): SessionRef[] {
  const found = new Map<string, SessionRef>();
  for (const text of texts) {
    for (const ref of extractRefs(text, config)) {
      if (!found.has(ref.key)) found.set(ref.key, ref);
    }
  }
  return [...found.values()];
}

/**
 * Union of several ref lists, de-duplicated by `key`, in first-seen order.
 *
 * Used to fold newly-seen references into the ones a session already carries.
 * Refs from the opening prompt are passed first so the session's subject keeps
 * the leading chip, with anything picked up later in the conversation trailing
 * it.
 */
export function mergeRefs<T extends { key: string }>(...lists: readonly (readonly T[])[]): T[] {
  const found = new Map<string, T>();
  for (const list of lists) {
    for (const ref of list) {
      if (!found.has(ref.key)) found.set(ref.key, ref);
    }
  }
  return [...found.values()];
}

/**
 * Pull `owner/repo` out of a `.git/config`'s origin remote.
 *
 * Lets a bare `#28388` resolve to the workspace's own repository, which a
 * single global setting can't do — beehiiv PRs and Anima issues are different
 * repos, and the correct one is already recorded per checkout. Config remains
 * available as an override.
 *
 * Handles both remote spellings:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 */
export function parseGithubRemote(gitConfig: string): string | null {
  // Prefer origin, but accept any GitHub remote when origin isn't one.
  const matches = [...gitConfig.matchAll(/url\s*=\s*(\S+)/g)].map((m) => m[1] ?? "");
  for (const url of matches) {
    const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
    const https = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (https) return `${https[1]}/${https[2]}`;
  }
  return null;
}

/**
 * Read refs configuration out of the extension's `anima.json` block, ignoring
 * anything malformed rather than throwing during a session list.
 */
export function readRefsConfig(config: Record<string, unknown> | undefined): RefsConfig {
  const raw = config?.refs;
  // Always return the same shape, so callers never have to handle both a
  // normalized config and a bare `{}`.
  const refs: RefsConfig = raw && typeof raw === "object" ? (raw as RefsConfig) : {};

  const prefixes = refs.linear?.prefixes;
  return {
    linear: {
      prefixes: Array.isArray(prefixes)
        ? prefixes.filter((p): p is string => typeof p === "string" && /^[A-Z][A-Z0-9]*$/.test(p))
        : [],
      workspace: typeof refs.linear?.workspace === "string" ? refs.linear.workspace : undefined,
    },
    github: {
      defaultRepo:
        typeof refs.github?.defaultRepo === "string" ? refs.github.defaultRepo : undefined,
      minDigits:
        typeof refs.github?.minDigits === "number" ? refs.github.minDigits : DEFAULT_MIN_DIGITS,
    },
  };
}
