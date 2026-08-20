/**
 * Live session status — the write-and-announce funnel.
 *
 * Phase 3's whole point is that nothing about the session list was live: every
 * tab held its own snapshot, taken when it loaded. Two events fix that, and
 * both originate here rather than in the reconciler. The reconciler derives
 * state from the filesystem on the read path; status changes arrive from
 * agent-host in real time, so the event has to be emitted where the state
 * actually moves.
 *
 * Two events, deliberately different shapes:
 *
 *   `session.status_changed` — one session moved. Carries enough for a tab to
 *     patch the row in place, with no refetch. High frequency, so it only
 *     fires on an actual transition.
 *
 *   `session.list_changed` — the membership of a workspace's list changed
 *     (created, archived, hidden by disposition). Carries no rows: the tab
 *     refetches, because working out an insert position client-side means
 *     duplicating the server's ordering rules in two places.
 *
 * Both are emitted unrouted — no `connectionId`, no tags. That's the point.
 * The per-session stream events are scoped to the connection that asked for
 * them; these go to every tab that subscribed, which is what makes the tabs
 * agree.
 */

import { createLogger, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { getRuntime } from "./runtime";
import { getWorkspace } from "./workspace";
import {
  getSessionDb,
  getStoredSession,
  setSessionDisposition,
  touchSession,
  updateSessionRuntime,
  type RuntimeStatus,
  type SessionDisposition,
} from "./session-store";

const log = createLogger("SessionExt:Status", join(homedir(), ".anima", "logs", "session.log"));

export const SESSION_STATUS_CHANGED = "session.status_changed";
export const SESSION_LIST_CHANGED = "session.list_changed";
export const SESSION_ACTIVITY = "session.activity";

/** Why a workspace's list needs refetching — surfaced for debugging, not logic. */
export type ListChangeReason =
  | "session_created"
  | "session_closed"
  | "disposition_changed"
  | "renamed"
  | "reconciled";

export interface SessionStatusChangedPayload {
  sessionId: string;
  workspaceId: string | null;
  cwd: string | null;
  runtimeStatus: RuntimeStatus;
  /** Absent on a disposition-only change. */
  previousRuntimeStatus?: RuntimeStatus;
  disposition: SessionDisposition;
  previousDisposition?: SessionDisposition;
  /** The row's name, so a rename reaches every tab without a refetch. */
  title: string | null;
  /** The derived name's source, for a session nobody has renamed. */
  firstPrompt: string | null;
  /** ISO — lets a receiving tab drop an event it has already superseded. */
  at: string;
}

/**
 * A session is still working — a heartbeat, not a transition.
 *
 * `status_changed` fires once, on the edge, which is correct and turned out to
 * be insufficient. A tab that connects mid-turn, misses the event, or has its
 * row overwritten by something that wrote `runtime_status` outside the funnel
 * shows a resting row for a session that is very much awake, and stays wrong
 * until the next sixty-second poll. Michael runs a tab per session and reads
 * the active pane as the answer to "what is she doing" across all of them, so
 * "usually right" is the failure.
 *
 * A repeated assertion fixes that in a way an edge never can: every streamed
 * event re-states the current truth, so a tab is at most one throttle window
 * stale no matter what it missed. It is deliberately a *different* event from
 * `status_changed` — consumers of that one treat it as a transition and refetch
 * on it, and a refetch per token would be indefensible. This one carries the
 * whole row's live fields so a tab can patch in place and never ask.
 */
export interface SessionActivityPayload {
  sessionId: string;
  workspaceId: string | null;
  runtimeStatus: RuntimeStatus;
  disposition: SessionDisposition;
  title: string | null;
  firstPrompt: string | null;
  at: string;
}

/**
 * Emit `session.status_changed` for a session, reading its current state.
 *
 * Returns false when the session has no row, which happens legitimately: the
 * lifecycle can see events for a session the reconciler hasn't upserted yet.
 * That's a missed event on a row nothing is rendering, not an error.
 */
export function emitStatusChanged(
  sessionId: string,
  transition?: {
    previousRuntimeStatus?: RuntimeStatus;
    previousDisposition?: SessionDisposition;
  },
): boolean {
  const stored = getStoredSession(sessionId);
  if (!stored) return false;

  const workspace = stored.workspaceId ? getWorkspace(stored.workspaceId) : null;
  const payload: SessionStatusChangedPayload = {
    sessionId,
    workspaceId: stored.workspaceId ?? null,
    cwd: workspace?.cwd ?? null,
    runtimeStatus: stored.runtimeStatus,
    previousRuntimeStatus: transition?.previousRuntimeStatus,
    disposition: stored.disposition,
    previousDisposition: transition?.previousDisposition,
    title: stored.title ?? null,
    firstPrompt: storedFirstPrompt(stored),
    at: new Date().toISOString(),
  };

  safeEmit(SESSION_STATUS_CHANGED, payload);
  return true;
}

/** Emit `session.list_changed` for one workspace. */
export function emitListChanged(workspaceId: string, reason: ListChangeReason): void {
  const workspace = getWorkspace(workspaceId);
  safeEmit(SESSION_LIST_CHANGED, {
    workspaceId,
    cwd: workspace?.cwd ?? null,
    reason,
    at: new Date().toISOString(),
  });
}

/**
 * Move a session's runtime status and announce it if it actually moved.
 *
 * The single funnel for the machine axis: callers on the lifecycle path use
 * this instead of `touchSession` / `updateSessionRuntime` directly, so there's
 * one place where "wrote the DB" and "told the tabs" can't drift apart.
 *
 * `touch: true` bumps `last_activity` as well, which is what the streaming
 * path wants; a status correction that isn't activity (a stall sweep, say)
 * passes false.
 */
export function applyRuntimeStatus(
  sessionId: string,
  runtimeStatus: RuntimeStatus,
  options?: { metadataPatch?: Record<string, unknown>; touch?: boolean },
): boolean {
  const transition = options?.metadataPatch
    ? updateSessionRuntime(sessionId, runtimeStatus, options.metadataPatch)
    : options?.touch === false
      ? updateSessionRuntime(sessionId, runtimeStatus)
      : touchSession(sessionId, runtimeStatus);

  if (!transition) return false;
  emitStatusChanged(sessionId, { previousRuntimeStatus: transition.from });
  // A transition is the one beat that must never be throttled away: it's how a
  // spinner *stops*. Forcing it also resets the window, so the next streamed
  // event doesn't immediately re-announce what this just said.
  emitActivity(sessionId, { force: true });
  return true;
}

/**
 * Move a session's disposition and announce it.
 *
 * A disposition change can also change list membership — `resolved` and
 * `archived` are hidden by default — so this emits both events. The list event
 * is the one that removes the row; the status event is what updates a tab
 * already showing it under a filter that still includes it.
 */
export function applyDisposition(sessionId: string, disposition: SessionDisposition): boolean {
  const transition = setSessionDisposition(sessionId, disposition);
  if (!transition) return false;

  const stored = getStoredSession(sessionId);
  emitStatusChanged(sessionId, { previousDisposition: transition.from });
  emitActivity(sessionId, { force: true });
  if (stored?.workspaceId) emitListChanged(stored.workspaceId, "disposition_changed");
  log.info("Disposition changed", {
    sessionId: shortId(sessionId),
    from: transition.from,
    to: transition.to,
  });
  return true;
}

/**
 * Reconcile in-flight runtime statuses against the process table at startup.
 *
 * `running` and the two `awaiting_*` states are claims about a process that
 * exists right now. Nothing writes the closing transition when the extension
 * dies mid-turn — a restart, a crash, a `watchdog reload` — so those rows keep
 * their claim forever. Before this existed the live database had four sessions
 * permanently marked `running`, and a dot that is always green is worse than
 * no dot at all: it trains you to ignore the one that matters.
 *
 * The discipline is the one the CLI registry learned the hard way: the
 * database is a cache, the process table is ground truth. Anything claiming to
 * be in flight without a live process is marked `stalled` — deliberately not
 * `idle`, because "we don't know how this turn ended" is a different and more
 * interesting fact than "nothing is happening".
 *
 * Returns the number of rows corrected.
 */
export function reconcileInFlightStatuses(liveSessionIds: ReadonlySet<string>): number {
  const rows = getSessionDb()
    .query(
      `SELECT provider_session_id FROM sessions
        WHERE status = 'active' AND runtime_status IN ('running','awaiting_input','awaiting_approval')`,
    )
    .all() as Array<{ provider_session_id: string }>;

  let corrected = 0;
  for (const row of rows) {
    if (liveSessionIds.has(row.provider_session_id)) continue;
    if (applyRuntimeStatus(row.provider_session_id, "stalled", { touch: false })) corrected++;
  }

  if (corrected > 0) {
    log.info("Cleared stale in-flight statuses at startup", {
      corrected,
      checked: rows.length,
    });
  }
  return corrected;
}

/** The prompt a session's derived name comes from, if one has been recorded. */
function storedFirstPrompt(stored: { metadata?: Record<string, unknown> | null }): string | null {
  const value = stored.metadata?.firstPrompt;
  return typeof value === "string" ? value : null;
}

/**
 * How often one session may assert "still working" on the bus.
 *
 * The heartbeat is driven by streamed events, which arrive per token — so the
 * throttle, not the source, is what sets the cost. A second is short enough
 * that a spinner appears to start the instant a turn does, and long enough
 * that a fast turn produces single-digit messages rather than hundreds.
 */
const ACTIVITY_THROTTLE_MS = 1_000;

const lastActivityAt = new Map<string, number>();

/**
 * Announce that a session is alive, at most once per throttle window.
 *
 * Reads the row rather than taking the caller's word for the status: the point
 * is to re-assert what is *true*, and a caller that thinks a session is
 * running when the database says otherwise is exactly the drift this exists to
 * correct.
 */
export function emitActivity(sessionId: string, options?: { force?: boolean }): void {
  const now = Date.now();
  const previous = lastActivityAt.get(sessionId);
  if (!options?.force && previous !== undefined && now - previous < ACTIVITY_THROTTLE_MS) return;

  const stored = getStoredSession(sessionId);
  if (!stored) return;
  lastActivityAt.set(sessionId, now);

  const payload: SessionActivityPayload = {
    sessionId,
    workspaceId: stored.workspaceId ?? null,
    runtimeStatus: stored.runtimeStatus,
    disposition: stored.disposition,
    title: stored.title ?? null,
    firstPrompt: storedFirstPrompt(stored),
    at: new Date().toISOString(),
  };
  safeEmit(SESSION_ACTIVITY, payload);
}

/** Drop a session's throttle state — it is finished, and won't beat again. */
export function forgetActivity(sessionId: string): void {
  lastActivityAt.delete(sessionId);
}

/**
 * Emit without letting a bus failure take down the caller.
 *
 * These events are advisory — a tab that misses one is stale until its next
 * refetch, which is exactly where it was before Phase 3. Throwing out of the
 * lifecycle path to deliver one would be a strictly worse trade.
 */
function safeEmit(event: string, payload: unknown): void {
  try {
    getRuntime().ctx.emit(event, payload);
  } catch (err) {
    log.warn("Failed to emit status event", {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
