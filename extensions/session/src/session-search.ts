/**
 * Find a session by what was said in it.
 *
 * Search was previously a substring match over the titles already loaded in the
 * nav — which meant it could only find sessions you had already scrolled to, by
 * text that was mostly `<command-message>` envelopes. This reads the transcript
 * corpus instead: every user message and every piece of assistant prose, back to
 * the first session on 2025-08-10.
 *
 * ## Why it borrows memory's index
 *
 * `memory_transcript_entries` is the only parsed copy of the conversations, and
 * memory owns it. Session asks over `ctx.call("memory.search_transcripts")`
 * rather than querying that table directly — the same boundary
 * `memory.get_session_context` already sits behind. What comes back is a ranked
 * list of session ids and excerpts; this module supplies everything session owns
 * (workspace, title, refs, whether the transcript still exists) and drops hits
 * it can't route to.
 *
 * ## Known limits, inherited from the corpus
 *
 * Tool inputs and outputs aren't stored — an assistant turn that ran commands is
 * recorded as `[Used tools: Bash]` — so a file path or a command's output that
 * never appeared in prose will not match. Libby's own sessions are excluded from
 * ingest and so from search. Both are surfaced in the UI rather than silently
 * shaping results.
 */

import { createLogger } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { findSessionsByRef, getSessionsForSearch, type StoredSessionRef } from "./session-store";

const log = createLogger("SessionExt:Search", join(homedir(), ".anima", "logs", "session.log"));

/** Hits requested from memory before workspace resolution drops the unroutable. */
const OVERFETCH = 3;

export interface SearchHit {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  /** Explicit rename if there is one, else the derived opening prompt. */
  title: string;
  /** Excerpt from the best-matching message, `«match»`-delimited. */
  snippet: string;
  /** Which side said it. */
  role: "user" | "assistant";
  /** Matching messages in this session. */
  matches: number;
  /** Timestamp of the most recent matching message. */
  matchedAt: string;
  /** Transcript no longer on disk — openable only from the backup. */
  archived: boolean;
  refs: StoredSessionRef[];
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** Hits dropped because no registered workspace claims the session. */
  unroutable: number;
}

interface TranscriptHit {
  sessionId: string;
  cwd: string;
  timestamp: string;
  snippet: string;
  role: "user" | "assistant";
  matches: number;
  rank: number;
}

export interface SearchOptions {
  query: string;
  /** Restrict to one workspace by its cwd. Omitted means every workspace. */
  cwd?: string;
  /** Restrict to sessions carrying this PR/ticket key, e.g. `anima#61`. */
  ref?: string;
  limit?: number;
}

/**
 * FTS5 treats `-`, `#`, `/` and friends as syntax, so a query typed into a
 * search box — `PR #412`, `feat/session-fts` — is a syntax error rather than a
 * search. Each run of word characters becomes a quoted term, and a trailing
 * partial word gets a `*` so results narrow as you type.
 */
export function toMatchQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;

  const endsMidWord = /[\p{L}\p{N}_]$/u.test(raw);
  return tokens
    .map((token, i) => {
      const quoted = `"${token}"`;
      return endsMidWord && i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" AND ");
}

export async function searchSessions(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  options: SearchOptions,
): Promise<SearchResult> {
  const limit = options.limit ?? 20;
  const match = toMatchQuery(options.query);
  if (!match) return { query: options.query, hits: [], unroutable: 0 };

  // A ref filter is an allow-list of session ids rather than a post-filter: a
  // session that mentions #61 once may not rank in the top matches for the text
  // query at all, and it's exactly the row being looked for.
  const sessionIds = options.ref ? findSessionsByRef(options.ref) : undefined;
  if (sessionIds && sessionIds.length === 0) {
    return { query: options.query, hits: [], unroutable: 0 };
  }

  const response = (await call("memory.search_transcripts", {
    query: match,
    limit: limit * OVERFETCH,
    cwd: options.cwd,
    sessionIds,
  })) as { results?: TranscriptHit[] } | null;

  const results = response?.results ?? [];
  if (results.length === 0) return { query: options.query, hits: [], unroutable: 0 };

  const rows = getSessionsForSearch(results.map((hit) => hit.sessionId));

  const hits: SearchHit[] = [];
  let unroutable = 0;
  for (const hit of results) {
    const row = rows.get(hit.sessionId);
    if (!row) {
      unroutable++;
      continue;
    }
    if (hits.length >= limit) continue;
    hits.push({
      sessionId: hit.sessionId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      title: row.title || row.firstPrompt || "Untitled session",
      snippet: hit.snippet,
      role: hit.role,
      matches: hit.matches,
      matchedAt: hit.timestamp,
      archived: row.archived,
      refs: row.refs,
    });
  }

  log.info("Session search", {
    query: options.query,
    match,
    hits: hits.length,
    unroutable,
    ref: options.ref,
  });

  return { query: options.query, hits, unroutable };
}
