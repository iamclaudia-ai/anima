/**
 * Ask GitHub whether an extracted ref is real, and **remember the answer —
 * especially when it's no**.
 *
 * Extraction reads whole conversations, so it picks up anything shaped like
 * `#N`. `session-refs.ts` already rejects everything separable by pattern
 * (`[Image #9]`, `UTF-8`, `SHA-256`), but the remaining noise is not:
 *
 *   iamclaudia-ai/anima#171717   Tailwind `gray-900`, pasted as a hex colour
 *   iamclaudia-ai/anima#111827   same shape
 *   iamclaudia-ai/anima#28651    a real PR number — for a *different* repo
 *
 * That last class is the interesting one. A bare `#28651` resolves against the
 * workspace's own git remote, which is the right default, but it means a
 * beehiiv PR number mentioned while working in `anima` gets stamped
 * `iamclaudia-ai/anima#28651`. No pattern can catch that; the number is
 * perfectly well-formed. **The only reliable oracle is asking GitHub.**
 *
 * ## Why the negatives are the point
 *
 * A validator that merely dropped bad refs would rediscover them on the next
 * rescan, forever — the transcripts still say what they said. So this keeps a
 * cache row for *invalid* keys too, and extraction consults it at write time.
 * A hex colour is checked exactly once and then stays out of the nav, which is
 * what makes the sweep converge instead of re-litigating history every pass.
 *
 * ## Telling "fake" apart from "can't see it"
 *
 * `GET /repos/{owner}/{repo}/issues/{n}` returns **404 for a missing issue and
 * 404 for a repo the token can't read** — GitHub deliberately won't confirm a
 * private repo exists. Trusting that blindly means one expired token strips
 * every genuine `beehiiv/swarm` chip on the next sweep.
 *
 * So a 404 is only believed once the repo itself answers 200. If the repo
 * probe fails, every key under it is left untouched and uncached, and the next
 * pass tries again. The rule throughout: **only a confirmed miss is written;
 * "couldn't check" is never cached.**
 *
 * ## Why `fetch` and not `gh api`
 *
 * `gh api` reports a miss by exiting non-zero *and printing the error body to
 * stdout*, so a validator reading stdout alone would happily store
 * `{"message":"Not Found"}` as an issue number. It also can't distinguish 404
 * from 403 from 429 without parsing prose. The REST call gives the status code
 * directly, which is the whole distinction this module rests on. The token
 * still comes from `gh`, so there's no second credential to manage.
 */

import { createLogger } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSessionDb } from "./session-store";

const log = createLogger(
  "SessionExt:RefValidity",
  join(homedir(), ".anima", "logs", "session.log"),
);

/** `owner/repo#123`. A bare `#123` has no repo to ask about and is skipped. */
const QUALIFIED_KEY = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)$/;

/**
 * Keys checked per pass.
 *
 * The backlog is finite (~200 keys at time of writing) and the steady state is
 * a handful of new refs a day, so this only bounds the first sweep. Kept well
 * under the 5,000/hour authenticated limit even if every pass ran full.
 */
const DEFAULT_LIMIT = 50;

/** Concurrent requests. Small on purpose — this is background work. */
const CONCURRENCY = 4;

/** How often the background sweep looks for unchecked keys. */
const SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * Delay before the first sweep after start.
 *
 * Startup is already busy reconciling workspaces, and nothing here is urgent.
 */
const SWEEP_DELAY_MS = 60_000;

export type RefCheck = "valid" | "missing" | "unknown";

export interface ValidateResult {
  /** Keys checked against GitHub this pass. */
  checked: number;
  /** Keys confirmed to exist. */
  valid: number;
  /** Keys confirmed missing — cached, and their chips deleted. */
  invalid: number;
  /** `session_refs` rows removed. One key can be on many sessions. */
  removed: number;
  /** Keys we couldn't get a trustworthy answer for. Nothing was cached. */
  skipped: number;
  /** Repos whose probe failed, so their keys were left alone. */
  unreachableRepos: string[];
}

const validityTableReady = new WeakSet<object>();

/**
 * Keyed by connection, not a boolean: the database is closed and reopened
 * within a process (tests, `closeSessionDb` on reload), and a flag would claim
 * the table exists in a connection that has never seen it.
 */
function ensureValidityTable(): void {
  const db = getSessionDb();
  if (validityTableReady.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_ref_validity (
      ref_key    TEXT PRIMARY KEY,
      ref_type   TEXT NOT NULL,
      valid      INTEGER NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_ref_validity_valid ON session_ref_validity(valid, checked_at)`,
  );
  validityTableReady.add(db);
}

/** SQLite's default parameter ceiling is 999 — stay well under it. */
const KEY_CHUNK = 400;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The subset of `keys` already proven not to exist.
 *
 * Bulk rather than per-key because this sits on the ref-write path, which runs
 * for a whole page of sessions at a time.
 */
export function loadInvalidRefKeys(keys: readonly string[]): Set<string> {
  const invalid = new Set<string>();
  if (keys.length === 0) return invalid;
  ensureValidityTable();

  const db = getSessionDb();
  for (const batch of chunk(keys, KEY_CHUNK)) {
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT ref_key FROM session_ref_validity
          WHERE valid = 0 AND ref_key IN (${placeholders})`,
      )
      .all(...batch) as Array<{ ref_key: string }>;
    for (const row of rows) invalid.add(row.ref_key);
  }
  return invalid;
}

/**
 * Drop refs already known to be fake.
 *
 * Called where refs are persisted rather than where they're extracted:
 * extraction stays a pure function of text and config, and this is a fact
 * about the outside world that only the database knows.
 */
export function rejectKnownInvalidRefs<T extends { key: string }>(refs: readonly T[]): T[] {
  if (refs.length === 0) return [...refs];
  const invalid = loadInvalidRefKeys(refs.map((ref) => ref.key));
  if (invalid.size === 0) return [...refs];
  return refs.filter((ref) => !invalid.has(ref.key));
}

function recordValidity(key: string, type: string, valid: boolean): void {
  getSessionDb()
    .query(
      `INSERT INTO session_ref_validity (ref_key, ref_type, valid, checked_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(ref_key) DO UPDATE
         SET valid = excluded.valid, checked_at = excluded.checked_at`,
    )
    .run(key, type, valid ? 1 : 0);
}

/** Remove a confirmed-fake ref from every session carrying it. */
function deleteRefKey(key: string): number {
  return getSessionDb().query(`DELETE FROM session_refs WHERE ref_key = ?`).run(key).changes;
}

interface PendingKey {
  key: string;
  type: string;
  repo: string;
  number: string;
}

/**
 * Only qualified GitHub keys can be asked about — see `selectPendingKeys`.
 *
 * Takes the table alias because both `session_refs` and `session_ref_validity`
 * have `ref_key`, so an unqualified column is ambiguous inside the join.
 */
const checkable = (alias: string): string =>
  `${alias}.ref_type = 'github' AND ${alias}.ref_key LIKE '%/%#%'`;

/**
 * Refs that still need an answer, most-used first.
 *
 * Most-used first so a capped pass clears the keys cluttering the most rows.
 * Bare `#123` keys are excluded by the `LIKE '%/%#%'` filter — without a repo
 * there's nothing to ask. Linear refs are excluded by type: `linctl` could
 * answer for them, but that's a second integration and a separate decision.
 *
 * A `revalidate` pass also reaches into the verdict cache, not just the live
 * chips. Debunked keys have had their `session_refs` rows deleted, so a query
 * over chips alone could never see them again — which would make the escape
 * hatch unreachable for precisely the keys it exists for. The case is real:
 * a ref to `#74` written *before* that issue is filed is genuinely missing
 * when first checked and genuinely valid later.
 *
 * Note that clearing a negative verdict doesn't put the chip back on its own —
 * nothing records which sessions it was deleted from. `session.backfill_refs`
 * with `rescan` re-extracts it, now that the cache no longer rejects it.
 */
function selectPendingKeys(limit: number, revalidate: boolean): PendingKey[] {
  ensureValidityTable();
  const rows = getSessionDb()
    .query(
      revalidate
        ? `SELECT k.ref_key AS ref_key, k.ref_type AS ref_type, COALESCE(u.uses, 0) AS uses
             FROM (SELECT ref_key, ref_type FROM session_refs r WHERE ${checkable("r")}
                   UNION
                   SELECT ref_key, ref_type FROM session_ref_validity v WHERE ${checkable("v")}) k
             LEFT JOIN (SELECT ref_key, COUNT(*) AS uses FROM session_refs GROUP BY ref_key) u
                    ON u.ref_key = k.ref_key
            ORDER BY uses DESC, k.ref_key
            LIMIT ?`
        : `SELECT r.ref_key AS ref_key, r.ref_type AS ref_type, COUNT(*) AS uses
             FROM session_refs r
             LEFT JOIN session_ref_validity v ON v.ref_key = r.ref_key
            WHERE ${checkable("r")} AND v.ref_key IS NULL
            GROUP BY r.ref_key, r.ref_type
            ORDER BY uses DESC, r.ref_key
            LIMIT ?`,
    )
    .all(limit) as Array<{ ref_key: string; ref_type: string; uses: number }>;

  const pending: PendingKey[] = [];
  for (const row of rows) {
    const match = QUALIFIED_KEY.exec(row.ref_key);
    if (!match?.[1] || !match[2]) continue;
    pending.push({ key: row.ref_key, type: row.ref_type, repo: match[1], number: match[2] });
  }
  return pending;
}

let cachedToken: string | null | undefined;

/**
 * A GitHub token, preferring the environment and falling back to `gh`.
 *
 * Resolved once per process. `gh auth token` picks the account active for the
 * current directory, which for the extension host is Anima's own checkout —
 * fine in practice, since one account reads every repo referenced here, and a
 * repo it genuinely can't see is caught by the reachability probe rather than
 * being mistaken for a pile of fake refs.
 */
async function githubToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;

  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) {
    cachedToken = fromEnv;
    return cachedToken;
  }

  try {
    // `env` is passed explicitly rather than left to default. Bun resolves the
    // binary against the environment the spawn is given, and the implicit one
    // is a snapshot taken at process start — so a later change to
    // `process.env.PATH` is silently ignored. Being explicit makes the lookup
    // follow the process's current environment, which is what a caller means.
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const token = stdout.trim();
    cachedToken = exitCode === 0 && token ? token : null;
  } catch {
    // `gh` not installed or not on PATH — validation is simply unavailable.
    cachedToken = null;
  }
  return cachedToken;
}

/** Test seam: forget a resolved token so the next call re-reads it. */
export function resetGithubToken(): void {
  cachedToken = undefined;
}

interface GithubProbe {
  status: number;
  /** Set when the request never completed — network down, DNS, timeout. */
  failed?: boolean;
}

async function probe(path: string, token: string): Promise<GithubProbe> {
  try {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "anima-session-refs",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status };
  } catch {
    return { status: 0, failed: true };
  }
}

/**
 * Turn one issue probe into a verdict.
 *
 * Split out so the 404-only-means-missing rule is directly testable without a
 * network. Anything that isn't a clean 200 or a clean 404 — 403 (rate limit or
 * SSO), 401 (bad token), 5xx, a dead socket — is `unknown`, and `unknown` is
 * never written to the cache.
 */
export function classifyIssueProbe(status: number): RefCheck {
  if (status === 200) return "valid";
  if (status === 404) return "missing";
  return "unknown";
}

/** Run `task` over `items` with a bounded number in flight. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      // Non-null: `index` is in range, so the element exists.
      results[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Check unvalidated GitHub refs and clean up the ones that don't exist.
 *
 * Safe to run repeatedly: keys with a cached answer are skipped unless
 * `revalidate` is set, so a second run costs nothing.
 */
export async function validateSessionRefs(
  options: { limit?: number; revalidate?: boolean } = {},
): Promise<ValidateResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const result: ValidateResult = {
    checked: 0,
    valid: 0,
    invalid: 0,
    removed: 0,
    skipped: 0,
    unreachableRepos: [],
  };

  const pending = selectPendingKeys(limit, options.revalidate ?? false);
  if (pending.length === 0) return result;

  const token = await githubToken();
  if (!token) {
    log.warn("No GitHub token available — ref validation skipped", { pending: pending.length });
    result.skipped = pending.length;
    return result;
  }

  // Probe each repo once before believing any 404 under it. A repo the token
  // can't read 404s exactly like a missing issue, and without this an auth
  // blip would delete every chip for that repo.
  const repos = [...new Set(pending.map((entry) => entry.repo))];
  const reachable = new Map<string, boolean>();
  await pooled(repos, CONCURRENCY, async (repo) => {
    const { status } = await probe(`repos/${repo}`, token);
    reachable.set(repo, status === 200);
    if (status !== 200) {
      result.unreachableRepos.push(repo);
      log.warn("Repo unreachable — leaving its refs unvalidated", { repo, status });
    }
  });

  const checkable = pending.filter((entry) => reachable.get(entry.repo) === true);
  result.skipped += pending.length - checkable.length;

  const verdicts = await pooled(checkable, CONCURRENCY, async (entry) => {
    const { status } = await probe(`repos/${entry.repo}/issues/${entry.number}`, token);
    return { entry, verdict: classifyIssueProbe(status), status };
  });

  for (const { entry, verdict, status } of verdicts) {
    if (verdict === "unknown") {
      result.skipped++;
      log.warn("Inconclusive ref check — not cached", { key: entry.key, status });
      continue;
    }
    result.checked++;
    recordValidity(entry.key, entry.type, verdict === "valid");
    if (verdict === "valid") {
      result.valid++;
      continue;
    }
    result.invalid++;
    result.removed += deleteRefKey(entry.key);
  }

  if (result.checked > 0) {
    log.info("Validated session refs", {
      checked: result.checked,
      valid: result.valid,
      invalid: result.invalid,
      removed: result.removed,
      skipped: result.skipped,
    });
  }
  return result;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let startTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the background validation sweep. Returns an unsubscribe for shutdown.
 *
 * Deliberately not on the reconciler's one-minute tick: this makes network
 * calls, and nothing about a stale chip is urgent. The backlog drains over a
 * few passes and the steady state is a handful of new keys a day.
 */
export function startRefValidator(intervalMs: number = SWEEP_INTERVAL_MS): () => void {
  if (sweepTimer || startTimer) return () => stopRefValidator();

  const sweep = (): void => {
    validateSessionRefs().catch((error: unknown) => {
      log.warn("Ref validation sweep failed", { error: String(error) });
    });
  };

  startTimer = setTimeout(() => {
    startTimer = null;
    sweep();
    sweepTimer = setInterval(sweep, intervalMs);
    sweepTimer.unref?.();
  }, SWEEP_DELAY_MS);
  // Neither timer should hold the process open for background cleanup.
  startTimer.unref?.();

  log.info("Ref validator started", { intervalMs });
  return () => stopRefValidator();
}

export function stopRefValidator(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
}
