/**
 * Session reconciler — keeps the `sessions` table in step with the transcripts
 * Claude Code writes to `~/.claude/projects/`.
 *
 * The session list used to be filesystem-first: every `session.list_sessions`
 * synchronously scanned the project directory and read the head of each
 * transcript, then wrote what it found to SQLite and returned the filesystem
 * result anyway. The DB was written constantly and read almost never, and nav
 * render time scaled with the number of transcripts in the workspace.
 *
 * This inverts that. Reads come from SQLite (indexed on
 * `(workspace_id, purpose)` and `last_activity DESC`); the filesystem is
 * consulted here, off the request path.
 *
 * The DB stays a **derived cache** — every row is rebuildable from the JSONL,
 * so a corrupt or deleted table is a performance problem, never a data-loss
 * one.
 */

import { createLogger } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverSessions, resolveProjectDir } from "./claude-projects";
import { listWorkspaceSessions, upsertSession } from "./session-store";
import { getRuntime } from "./runtime";

const log = createLogger("SessionExt:Reconciler", join(homedir(), ".anima", "logs", "session.log"));

/**
 * Periodic sweep across every known workspace.
 *
 * Reads reconcile their own workspace inline, so this exists for the ones
 * nobody is looking at — keeping their rows current for cross-workspace views
 * and, later, for pushing live list updates to tabs that aren't focused there.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Grace before a session missing from disk is archived.
 *
 * A session created through Anima exists in the table before Claude Code has
 * flushed its transcript, so a sweep landing in that window would archive a
 * live session. Anything this recent is left alone.
 */
const PRUNE_GRACE_MS = 5 * 60_000;

const lastReconciledAt = new Map<string, number>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reconcile one workspace: discover its transcripts and upsert them.
 *
 * Titles are only re-derived for sessions that are new or whose mtime moved,
 * so a steady-state sweep costs one `readdir` plus a `stat` per file. When a
 * title is skipped the stored one is carried forward — `discoverSessions`
 * returns `firstPrompt: undefined` in that case, and writing that through
 * would erase a good title (or a user's explicit rename).
 */
export function reconcileWorkspace(cwd: string, workspaceId: string): number {
  const rt = getRuntime();

  const stored = new Map(listWorkspaceSessions(workspaceId).map((s) => [s.sessionId, s]));

  const discovered = discoverSessions(cwd, {
    needsTitle: (sessionId, modified) => {
      const existing = stored.get(sessionId);
      return !existing?.firstPrompt || existing.modified !== modified;
    },
  });

  let written = 0;
  for (const entry of discovered) {
    if (!entry.sessionId) continue;
    const existing = stored.get(entry.sessionId);

    // Skip untouched sessions entirely — no title was re-derived and the file
    // hasn't moved, so there is nothing new to persist.
    const lastActivity = entry.modified || entry.created;
    if (existing && !entry.firstPrompt && existing.modified === lastActivity) continue;

    upsertSession({
      id: entry.sessionId,
      workspaceId,
      providerSessionId: entry.sessionId,
      model: rt.sessionConfig.model,
      agent: "claude",
      purpose: "chat",
      runtimeStatus: "idle",
      metadata: {
        messageCount: entry.messageCount ?? existing?.messageCount,
        firstPrompt: entry.firstPrompt ?? existing?.firstPrompt,
        gitBranch: entry.gitBranch ?? existing?.gitBranch,
      },
      lastActivity,
    });
    written++;
  }

  const archived = pruneVanishedSessions(cwd, stored, discovered);

  lastReconciledAt.set(workspaceId, Date.now());
  if (written > 0 || archived > 0) {
    log.info("Reconciled workspace", { cwd, discovered: discovered.length, written, archived });
  }
  return written;
}

/**
 * Archive sessions whose transcripts are no longer on disk.
 *
 * Claude Code deletes transcripts after ~30 days, and the DB would otherwise
 * list them forever — clicking one loads no history, because `get_history`
 * resolves against the live projects directory. Archiving drops them from the
 * nav while **keeping the row**, so the title and metadata survive for search
 * (and `~/.claude/projects-backup` still holds the transcript itself).
 *
 * Two guards, because wrongly archiving a live session is far worse than
 * carrying a stale row for another minute:
 *   - Only prune when the project directory actually resolved. Otherwise a
 *     transient failure to see the filesystem would archive the workspace.
 *   - Never prune a session younger than the grace period, which may simply
 *     not have been written out yet.
 */
function pruneVanishedSessions(
  cwd: string,
  stored: Map<string, { modified: string }>,
  discovered: { sessionId: string }[],
): number {
  // Guard 1: if we couldn't resolve the project directory we never actually
  // looked, and archiving on a failed look would empty the workspace.
  if (!resolveProjectDir(cwd)) return 0;

  const doomed = selectVanishedSessions(stored, discovered, Date.now());
  const rt = getRuntime();
  for (const sessionId of doomed) rt.registry.archiveSession(sessionId);

  if (doomed.length > 0) {
    log.info("Archived sessions with no transcript on disk", { cwd, archived: doomed.length });
  }
  return doomed.length;
}

/**
 * Choose which stored sessions have vanished from disk and are old enough to
 * archive. Pure, so the guard that protects live sessions is directly testable.
 *
 * Guard 2 lives here: a session younger than the grace period is left alone
 * even when absent from disk, because Anima creates the row before Claude Code
 * writes the transcript. An unparseable timestamp is treated as *recent* —
 * when in doubt, keep the session.
 */
export function selectVanishedSessions(
  stored: Map<string, { modified: string }>,
  discovered: { sessionId: string }[],
  now: number,
  graceMs: number = PRUNE_GRACE_MS,
): string[] {
  const onDisk = new Set(discovered.map((entry) => entry.sessionId));
  const cutoff = now - graceMs;
  const doomed: string[] = [];

  for (const [sessionId, session] of stored) {
    if (onDisk.has(sessionId)) continue;
    const lastActivity = Date.parse(session.modified);
    if (!Number.isFinite(lastActivity) || lastActivity > cutoff) continue;
    doomed.push(sessionId);
  }

  return doomed;
}

/** Reconcile every known workspace. Returns how many rows were written. */
export function reconcileAllWorkspaces(): number {
  const rt = getRuntime();
  let written = 0;
  for (const workspace of rt.registry.listWorkspaces()) {
    try {
      written += reconcileWorkspace(workspace.cwd, workspace.id);
    } catch (error) {
      // One unreadable workspace must not stop the sweep.
      log.warn("Workspace reconcile failed", { cwd: workspace.cwd, error: String(error) });
    }
  }
  return written;
}

/**
 * Start the periodic sweep. Returns an unsubscribe for extension shutdown.
 *
 * The sweep is what picks up sessions created outside Anima (the raw `claude`
 * TUI), since nothing tells us about those.
 */
export function startReconciler(intervalMs: number = SWEEP_INTERVAL_MS): () => void {
  if (sweepTimer) return () => stopReconciler();

  sweepTimer = setInterval(() => {
    try {
      reconcileAllWorkspaces();
    } catch (error) {
      log.warn("Sweep failed", { error: String(error) });
    }
  }, intervalMs);
  // Don't hold the process open for a cache refresh.
  sweepTimer.unref?.();

  log.info("Session reconciler started", { intervalMs });
  return () => stopReconciler();
}

export function stopReconciler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  lastReconciledAt.clear();
}
