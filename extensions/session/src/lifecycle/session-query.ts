import { createLogger, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionIndexEntry } from "../claude-projects";
import { reconcileWorkspace } from "../session-reconciler";
import type { MemoryContextResult } from "../memory-context";
import { formatMemoryContext } from "../memory-context";
import { resolveSessionPath, parseSessionFilePaginated, parseSessionUsage } from "../parse-session";
import { listWorkspaceSessions, getStoredSession } from "../session-store";
import { getRuntime } from "../runtime";

const log = createLogger("SessionExt:Query", join(homedir(), ".anima", "logs", "session.log"));

/**
 * List a workspace's sessions from SQLite.
 *
 * This used to read the head of every transcript on every call, which is what
 * made opening the nav take seconds. Now titles and metadata are cached in the
 * `sessions` table, and reconciling only re-reads transcripts that are new or
 * whose mtime moved — measured on an 86-session workspace, that drops the scan
 * from 31.3ms to 0.4ms (a `readdir` plus one `stat` per file).
 *
 * Cheap enough to stay inline, which is worth more than it sounds: a purely
 * background refresh would serve stale results right after a session is created
 * outside Anima, and "my new session isn't in the list" is exactly the kind of
 * bug that erodes trust in the list. The periodic sweep still runs, so other
 * workspaces stay current without being read.
 */
export function listSessions(
  cwd: string,
  options?: { limit?: number; offset?: number },
): { sessions: SessionIndexEntry[]; total: number; hasMore: boolean } {
  const rt = getRuntime();
  const workspaceResult = rt.registry.getOrCreateWorkspace(cwd);
  const workspaceId = workspaceResult.workspace.id;

  reconcileWorkspace(cwd, workspaceId);
  const all = listWorkspaceSessions(workspaceId);

  // Newest *created* first, not most recently active — the same rule the work
  // queue follows, so the two lists in the nav never disagree about where a
  // session lives. Recency ordering rearranged a folder every time an
  // unrelated session finished a turn, which makes a list you can't learn:
  // the row you reached for is no longer the row under the cursor. Creation
  // order never changes, so a session stays where you last saw it.
  const sorted = all.sort((a, b) => {
    const aTime = a.created || a.modified || "";
    const bTime = b.created || b.modified || "";
    return bTime.localeCompare(aTime);
  });

  const offset = options?.offset ?? 0;
  const limit = options?.limit;
  const sliced = limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
  const hasMore = offset + sliced.length < sorted.length;

  log.info("Listed sessions", {
    cwd,
    total: sorted.length,
    returned: sliced.length,
    offset,
    limit: limit ?? "all",
  });
  return { sessions: sliced, total: sorted.length, hasMore };
}

export function getHistory(params: {
  sessionId: string;
  cwd?: string;
  limit?: number;
  offset?: number;
}): {
  messages: unknown[];
  total: number;
  hasMore: boolean;
  usage?: unknown;
  gitStatus?: unknown;
} {
  const filepath = resolveSessionPath(params.sessionId, params.cwd);
  if (!filepath) {
    log.warn("Session file not found", {
      sessionId: shortId(params.sessionId),
      cwd: params.cwd || "none",
    });
    return { messages: [], total: 0, hasMore: false };
  }

  const result = parseSessionFilePaginated(filepath, {
    limit: params.limit || 50,
    offset: params.offset || 0,
  });
  const usage = parseSessionUsage(filepath);
  const stored = getStoredSession(params.sessionId);
  const gitStatus = stored?.metadata?.gitStatus ?? undefined;

  log.info("Loaded history", {
    sessionId: shortId(params.sessionId),
    total: result.total,
    limit: params.limit || 50,
    offset: params.offset || 0,
    hasUsage: !!usage,
  });

  return { ...result, usage, gitStatus };
}

export async function getMemoryContext(cwd?: string): Promise<{
  formatted: string | null;
  raw: MemoryContextResult | null;
  formattedLength?: number;
  note?: string;
  error?: string;
}> {
  const rt = getRuntime();
  const effectiveCwd = cwd || process.cwd();
  const workspace = rt.registry.getWorkspaceByCwd(effectiveCwd);

  try {
    const memoryContext = (await rt.ctx.call("memory.get_session_context", {
      cwd: effectiveCwd,
      includeAllSummaries: workspace?.general === true,
    })) as MemoryContextResult | null;

    if (!memoryContext) {
      return { formatted: null, raw: null, note: "No memory context available" };
    }

    const formatted = formatMemoryContext(memoryContext);
    return {
      formatted,
      raw: memoryContext,
      formattedLength: formatted?.length || 0,
    };
  } catch (err) {
    return { formatted: null, raw: null, error: String(err) };
  }
}
