/**
 * "You asked for this, and it's done."
 *
 * The failure this exists for: ask for a PR review, get pulled into something
 * else, and never come back. Nothing was broken and nothing was blocked — the
 * work finished quietly and no part of the system said so.
 *
 * Design constraints, each one a way this could have been annoying instead of
 * useful:
 *
 * - **One banner, not one per session.** Three finished reviews producing
 *   three stacked banners is the same failure as three notifications.
 * - **It appears late, not immediately.** A session that finishes while you're
 *   looking at it needs no banner; the dot already said so. This is for work
 *   that has been waiting {@link ESCALATE_AFTER_MS}.
 * - **Seeing is not acknowledging.** Opening a session drops it from the
 *   banner for this tab, because you've clearly seen it — but it does *not*
 *   mark it resolved. Automatic status changes that hide work are what erode
 *   trust in the list. Michael says when something is done.
 * - **Snooze has to actually come back.** Otherwise it's dismissal with extra
 *   steps, and he'll stop trusting it and stop using it.
 *
 * Rendered app-wide rather than in the chat page, because the whole point is
 * that it reaches you when you are looking at something else.
 */

import { useState, useSyncExternalStore } from "react";
import { Check, Clock, X } from "lucide-react";
import {
  useAttentionSessions,
  waitedMs,
  type AttentionSession,
} from "../hooks/useAttentionSessions";
import { matchPath, navigate } from "../router";

/**
 * The session this tab is currently looking at.
 *
 * Read from the location rather than `useRouter()` because this component
 * mounts *outside* the Router — it has to, since it must appear on every
 * route. `navigate()` dispatches `popstate`, which is the same signal the
 * Router itself listens to, so this stays in step with client-side navigation.
 */
function subscribeToLocation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function readPathname(): string {
  return window.location.pathname;
}

function useCurrentSessionId(): string | undefined {
  // `useSyncExternalStore` rather than state-plus-effect: the location is an
  // external store, and reading it through this hook is what keeps the value
  // consistent if React renders concurrently.
  const pathname = useSyncExternalStore(subscribeToLocation, readPathname, readPathname);
  return matchPath("/chat/:workspaceId/:sessionId", pathname)?.sessionId;
}

function waitedLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function sessionLabel(session: AttentionSession): string {
  const name = session.title?.trim() || session.firstPrompt?.trim();
  if (name) return name;
  return session.sessionId.slice(0, 8);
}

export function AttentionBanner() {
  const currentSessionId = useCurrentSessionId();
  const { overdue, now, acknowledge, snooze } = useAttentionSessions({ currentSessionId });
  // Per-tab, and deliberately not persisted: "I've seen it" is a fact about
  // this tab right now, not a durable property of the session.
  const [seen, setSeen] = useState<Set<string>>(new Set());

  const rows = overdue.filter(
    (session) => session.sessionId !== currentSessionId && !seen.has(session.sessionId),
  );
  if (rows.length === 0) return null;

  const markSeen = (sessionId: string) =>
    setSeen((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });

  const open = (session: AttentionSession) => {
    markSeen(session.sessionId);
    navigate(`/chat/${session.workspaceId}/${session.sessionId}`);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[9998] flex justify-center px-4 pt-3">
      <div className="pointer-events-auto w-full max-w-2xl rounded-xl border border-amber-300 bg-amber-50/95 shadow-lg shadow-amber-900/10 backdrop-blur-xl">
        <div className="flex items-center gap-2 border-b border-amber-200 px-4 py-2">
          <span className="text-sm">💙</span>
          <span className="text-sm font-medium text-amber-900">
            {rows.length === 1
              ? "One session finished and is waiting on you"
              : `${rows.length} sessions finished and are waiting on you`}
          </span>
        </div>

        <ul className="divide-y divide-amber-200/70">
          {rows.map((session) => (
            <li key={session.sessionId} className="flex items-center gap-3 px-4 py-2">
              <button
                type="button"
                onClick={() => open(session)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-sm text-amber-900 hover:underline">
                  {sessionLabel(session)}
                </span>
                <span className="text-xs text-amber-700">
                  {session.workspaceName} · waiting {waitedLabel(waitedMs(session, now))}
                </span>
              </button>

              <button
                type="button"
                title="Remind me in 30 minutes"
                onClick={() => void snooze(session.sessionId, 30)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-amber-700 hover:bg-amber-200/60"
              >
                <Clock className="size-3.5" />
                Snooze
              </button>
              {/* The deliberate act. Nothing else in the system sets this. */}
              <button
                type="button"
                title="Mark this session resolved"
                onClick={() => void acknowledge(session.sessionId)}
                className="flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
              >
                <Check className="size-3.5" />
                Done
              </button>
              {/* Hides the row for this tab only — same as having looked at it. */}
              <button
                type="button"
                title="Dismiss for now (does not change the session's status)"
                onClick={() => markSeen(session.sessionId)}
                className="rounded p-1 text-amber-500 hover:bg-amber-200/60 hover:text-amber-800"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
