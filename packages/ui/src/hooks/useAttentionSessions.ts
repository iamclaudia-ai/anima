/**
 * The sessions currently wanting attention, kept live.
 *
 * Two update paths, because the set changes for two different reasons:
 *
 * - **Events.** `session.status_changed` means something moved, so refetch.
 *   Debounced, since a turn produces at least two of them and a busy morning
 *   produces a lot more.
 * - **A clock.** Nothing fires when a snooze expires or when a session crosses
 *   the "you've been ignoring this for 15 minutes" line. Those are time, not
 *   events, so a slow interval is the only honest way to notice them.
 *
 * The list is fetched rather than derived from the nav's per-workspace pages
 * on purpose: those pages hold five rows per workspace, and pagination is
 * exactly what would drop a workspace's seventh-most-recent session from a
 * list whose whole job is to not lose anything.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useGatewayClientContext } from "../contexts/GatewayClientContext";
import type { SessionDisposition, SessionRuntimeStatus } from "./useChatGateway";

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
}

/** How long a finished session waits before it stops being polite about it. */
export const ESCALATE_AFTER_MS = 15 * 60_000;

/** Slow enough to be invisible, fast enough that "15 minutes" means it. */
const POLL_INTERVAL_MS = 60_000;

/** Long enough to collapse a turn's burst of events into one fetch. */
const REFETCH_DEBOUNCE_MS = 1_000;

export interface UseAttentionSessionsReturn {
  sessions: AttentionSession[];
  /** Finished, unacknowledged, and waiting longer than the escalation window. */
  overdue: AttentionSession[];
  refresh: () => void;
  acknowledge: (sessionId: string) => Promise<void>;
  snooze: (sessionId: string, minutes: number) => Promise<void>;
}

/** Is this session finished and waiting on a human, as opposed to working? */
export function isAwaitingAcknowledgement(session: AttentionSession): boolean {
  return session.runtimeStatus === "completed";
}

export function waitedMs(session: AttentionSession, now: number): number {
  const at = Date.parse(session.waitingSince);
  return Number.isFinite(at) ? now - at : 0;
}

export function useAttentionSessions(): UseAttentionSessionsReturn {
  const ctx = useGatewayClientContext();
  const client = ctx?.client ?? null;
  const isConnected = ctx?.isConnected ?? false;

  const [sessions, setSessions] = useState<AttentionSession[]>([]);
  // Re-render on a timer so elapsed-time thresholds are crossed without an
  // event — "it has been 15 minutes" is a fact about the clock, not the data.
  const [now, setNow] = useState(() => Date.now());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientRef = useRef(client);

  useEffect(() => {
    clientRef.current = client;
  });

  const refresh = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    void c
      .call<{ sessions?: AttentionSession[] }>("session.list_attention")
      .then((result) => setSessions(result?.sessions ?? []))
      .catch(() => {
        // Leave the previous list in place. A failed poll should not empty a
        // banner that is telling Michael something real.
      });
  }, []);

  useEffect(() => {
    if (!client || !isConnected) return;

    refresh();
    void client.subscribe(["session.status_changed"]).catch(() => undefined);

    const scheduleRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(refresh, REFETCH_DEBOUNCE_MS);
    };
    const off = client.on("session.status_changed", scheduleRefresh);

    const timer = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      off();
      clearInterval(timer);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Deliberately no unsubscribe: the nav subscribes to the same event, and
      // unsubscribing here would silence it too. The gateway's subscriptions
      // are per connection, not per component.
    };
  }, [client, isConnected, refresh]);

  const acknowledge = useCallback(
    async (sessionId: string) => {
      await clientRef.current?.call("session.set_status", { sessionId, disposition: "resolved" });
      refresh();
    },
    [refresh],
  );

  const snooze = useCallback(
    async (sessionId: string, minutes: number) => {
      await clientRef.current?.call("session.snooze", { sessionId, minutes });
      refresh();
    },
    [refresh],
  );

  const overdue = sessions.filter(
    (s) => isAwaitingAcknowledgement(s) && waitedMs(s, now) >= ESCALATE_AFTER_MS,
  );

  return { sessions, overdue, refresh, acknowledge, snooze };
}
