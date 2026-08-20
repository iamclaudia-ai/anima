/**
 * The sessions currently wanting attention, kept live and shared.
 *
 * Two consumers in the same tab — the banner and the nav's active pane — and
 * they must never disagree, since the whole premise of this work is that every
 * view of a session says the same thing. So the data lives in one module-level
 * store with one poller, and both read it through `useSyncExternalStore`.
 * Mounting a second consumer costs a subscription, not another fetch.
 *
 * Two update paths, because the set changes for two different reasons:
 *
 * - **Events.** `session.status_changed` means something moved, so refetch.
 *   Debounced, since a turn produces several and a busy morning produces a lot.
 * - **A heartbeat.** `session.activity` re-asserts a live session about once a
 *   second while it's working, and is patched into the row in place rather
 *   than refetched — a refetch per second per busy session would be absurd,
 *   and the payload already carries everything that moves. This is what makes
 *   the pane's spinner trustworthy: the transition event is a single edge, and
 *   a tab that missed it used to sit on a resting row for up to a minute.
 * - **A clock.** Nothing fires when a snooze expires or when a session crosses
 *   the "you've been ignoring this for fifteen minutes" line. Those are facts
 *   about time, not events, so a slow interval is the only honest way to see
 *   them.
 *
 * The list is fetched rather than derived from the nav's per-workspace pages
 * on purpose: those pages hold five rows per workspace, and pagination is
 * exactly what would drop a workspace's seventh-most-recent session from a
 * list whose entire job is to not lose anything.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { GatewayClient } from "@anima/shared/gateway-client";
import { useGatewayClientContext } from "../contexts/GatewayClientContext";
import type { SessionDisposition, SessionRefInfo, SessionRuntimeStatus } from "./useChatGateway";

export interface AttentionSession {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  title: string | null;
  firstPrompt: string | null;
  runtimeStatus: SessionRuntimeStatus;
  disposition: SessionDisposition;
  lastActivity: string;
  /** What "waiting 20 minutes" is measured from — the turn's end, not a restart. */
  waitingSince: string;
  snoozedUntil: string | null;
  refs?: SessionRefInfo[];
}

/** How long a finished session waits before it stops being polite about it. */
export const ESCALATE_AFTER_MS = 15 * 60_000;

/**
 * The same, for a session *blocked* on a prompt (#69) — far shorter, because
 * the two cases are not the same kind of waiting.
 *
 * A finished session can wait fifteen minutes: the work is done, nothing is
 * lost, and interrupting immediately would fire on every turn that ends while
 * you're reading it. A blocked one makes no progress at all until someone
 * answers, and the whole failure this fixes is not knowing that. Still not
 * instant — a prompt answered in the pane within a few seconds should never
 * have raised a banner at all.
 */
export const ESCALATE_BLOCKED_AFTER_MS = 45_000;

/**
 * And how long before it gives up asking.
 *
 * The queue keeps unresolved work forever, by design — but a banner about
 * coming back *now* has no business citing something from last week. Past this
 * the row stays in the pane and stops interrupting.
 */
export const ESCALATE_UNTIL_MS = 24 * 3_600_000;

/** Slow enough to be invisible, fast enough that "fifteen minutes" means it. */
const POLL_INTERVAL_MS = 60_000;

/** Long enough to collapse a turn's burst of events into one fetch. */
const REFETCH_DEBOUNCE_MS = 1_000;

/** How often elapsed-time labels and thresholds get re-evaluated. */
const CLOCK_TICK_MS = 30_000;

// ── Shared store ─────────────────────────────────────────────

const EMPTY: AttentionSession[] = [];
let snapshot: AttentionSession[] = EMPTY;
const listeners = new Set<() => void>();
let client: GatewayClient | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let stopListening: (() => void) | null = null;

function getSnapshot(): AttentionSession[] {
  return snapshot;
}

function sameSessions(a: AttentionSession[], b: AttentionSession[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.sessionId === other.sessionId &&
      row.runtimeStatus === other.runtimeStatus &&
      row.disposition === other.disposition &&
      row.waitingSince === other.waitingSince &&
      row.title === other.title
    );
  });
}

/** Payload of `session.activity` — a live session re-asserting itself. */
export interface SessionActivityPayload {
  sessionId: string;
  runtimeStatus?: SessionRuntimeStatus;
  disposition?: SessionDisposition;
  title?: string | null;
  firstPrompt?: string | null;
}

/**
 * How long a beat for a session we don't have may go unexamined.
 *
 * A beat for an absent session usually means something just became worth
 * showing, so a fetch is right — but not every time. Some workspaces are
 * excluded from the queue on purpose (Libby's summarization runs, which are
 * machinery rather than work), and those stream all day. Fetching on each of
 * their beats would be a request a second, forever, for a row that is
 * deliberately never going to appear. One look a minute settles the question
 * for a session that genuinely does belong, and costs nothing for one that
 * never will.
 */
const UNKNOWN_SESSION_FETCH_INTERVAL_MS = 60_000;

let lastUnknownFetchAt = 0;

/**
 * Patch one row from a heartbeat, without going back to the server.
 *
 * A beat for a session that isn't in the list asks the server about it — the
 * client can't tell "new" from "deliberately excluded" — but rarely, per
 * above. Only the server knows where a new row sorts, so this can't be
 * resolved locally.
 */
/**
 * Everything a heartbeat can move on a row, applied to it.
 *
 * Returns the row unchanged — by identity — when nothing moved, which is the
 * common case: the beat exists to re-assert what is already true, and a fresh
 * object every second would re-render the banner and the nav for nothing.
 */
export function mergeActivity(
  current: AttentionSession,
  payload: SessionActivityPayload,
): AttentionSession {
  const next: AttentionSession = {
    ...current,
    runtimeStatus: payload.runtimeStatus ?? current.runtimeStatus,
    disposition: payload.disposition ?? current.disposition,
    title: payload.title !== undefined ? payload.title : current.title,
    firstPrompt: payload.firstPrompt !== undefined ? payload.firstPrompt : current.firstPrompt,
  };
  // Identity is the signal — the caller re-renders both consumers on a change,
  // and a heartbeat is by design mostly a repeat of what the row already says.
  if (
    next.runtimeStatus === current.runtimeStatus &&
    next.disposition === current.disposition &&
    next.title === current.title &&
    next.firstPrompt === current.firstPrompt
  ) {
    return current;
  }
  return next;
}

function applyActivity(payload: SessionActivityPayload): void {
  if (!payload?.sessionId) return;
  const index = snapshot.findIndex((s) => s.sessionId === payload.sessionId);
  if (index === -1) {
    const now = Date.now();
    if (now - lastUnknownFetchAt < UNKNOWN_SESSION_FETCH_INTERVAL_MS) return;
    lastUnknownFetchAt = now;
    scheduleFetch();
    return;
  }
  const current = snapshot[index];
  if (!current) return;

  const next = mergeActivity(current, payload);
  if (next === current) return;

  const updated = [...snapshot];
  updated[index] = next;
  // Bypasses `publish`'s equality check: it compares by identity per row and
  // would see this as a no-op change on a list of the same length. The
  // comparison above has already established the row moved.
  snapshot = updated;
  for (const listener of listeners) listener();
}

function publish(next: AttentionSession[]): void {
  // `useSyncExternalStore` compares snapshots by identity, so handing back a
  // fresh array every poll would re-render both consumers once a minute for
  // nothing.
  if (sameSessions(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function fetchNow(): void {
  const c = client;
  if (!c) return;
  void c
    .call<{ sessions?: AttentionSession[] }>("session.list_attention", {})
    .then((result) => publish(result?.sessions ?? EMPTY))
    .catch(() => {
      // Keep the previous list. A failed poll should not silently empty a
      // banner that is telling Michael something real.
    });
}

function scheduleFetch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fetchNow, REFETCH_DEBOUNCE_MS);
}

/** Begin polling and listening. Idempotent; safe to call on every connect. */
function start(next: GatewayClient): void {
  client = next;
  stopListening?.();
  // Listens, but deliberately does not subscribe. Gateway subscriptions are
  // per *connection*, not per component, and the nav already subscribes to
  // this event — so a subscribe/unsubscribe pair here would silence the nav.
  // On a route with no nav the poll below is the only update path, which is
  // fine for a list whose fastest-moving threshold is fifteen minutes.
  const offStatus = next.on("session.status_changed", scheduleFetch);
  // Also list changes: a rename alters what a row *says* without altering any
  // status, and the queue shows titles.
  const offList = next.on("session.list_changed", scheduleFetch);
  // The heartbeat patches in place — see `applyActivity`. Deliberately not a
  // refetch: this fires while a turn is streaming.
  const offActivity = next.on("session.activity", (_event, raw) =>
    applyActivity(raw as SessionActivityPayload),
  );
  stopListening = () => {
    offStatus();
    offList();
    offActivity();
  };
  if (!pollTimer) pollTimer = setInterval(fetchNow, POLL_INTERVAL_MS);
  fetchNow();
}

function stop(): void {
  lastUnknownFetchAt = 0;
  stopListening?.();
  stopListening = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  client = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // The last consumer leaving stops the poll — nothing is reading it, and a
    // timer that outlives its readers is just a background request loop.
    if (listeners.size === 0) stop();
  };
}

// ── Hook ─────────────────────────────────────────────────────

export interface UseAttentionSessionsReturn {
  /** Everything wanting attention — in flight, or done and unacknowledged. */
  sessions: AttentionSession[];
  /** The subset that has been waiting long enough to interrupt over. */
  overdue: AttentionSession[];
  /** Milliseconds, ticking — so labels and thresholds move without an event. */
  now: number;
  refresh: () => void;
  acknowledge: (sessionId: string) => Promise<void>;
  snooze: (sessionId: string, minutes: number) => Promise<void>;
}

/** Is this session blocked on a prompt only a human can answer (#69)? */
export function isBlockedOnPrompt(session: AttentionSession): boolean {
  return (
    session.runtimeStatus === "awaiting_approval" || session.runtimeStatus === "awaiting_input"
  );
}

/** Is this session waiting on a human, as opposed to working? */
export function isAwaitingAcknowledgement(session: AttentionSession): boolean {
  return session.runtimeStatus === "completed" || isBlockedOnPrompt(session);
}

/** How long this session may wait quietly before the banner speaks up. */
export function escalateAfterMs(session: AttentionSession): number {
  return isBlockedOnPrompt(session) ? ESCALATE_BLOCKED_AFTER_MS : ESCALATE_AFTER_MS;
}

export function waitedMs(session: AttentionSession, now: number): number {
  const at = Date.parse(session.waitingSince);
  return Number.isFinite(at) ? now - at : 0;
}

export function useAttentionSessions(): UseAttentionSessionsReturn {
  const ctx = useGatewayClientContext();
  const gatewayClient = ctx?.client ?? null;
  const isConnected = ctx?.isConnected ?? false;

  const sessions = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!gatewayClient || !isConnected) return;
    start(gatewayClient);
  }, [gatewayClient, isConnected]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const refresh = useCallback(() => fetchNow(), []);

  const acknowledge = useCallback(async (sessionId: string) => {
    await client?.call("session.set_status", { sessionId, disposition: "resolved" });
    fetchNow();
  }, []);

  const snooze = useCallback(async (sessionId: string, minutes: number) => {
    await client?.call("session.snooze", { sessionId, minutes });
    fetchNow();
  }, []);

  const overdue = sessions.filter((s) => {
    if (!isAwaitingAcknowledgement(s)) return false;
    const waited = waitedMs(s, now);
    return waited >= escalateAfterMs(s) && waited <= ESCALATE_UNTIL_MS;
  });

  return { sessions, overdue, now, refresh, acknowledge, snooze };
}
