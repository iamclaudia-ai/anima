/**
 * Support Page — every open ticket across projects, and one ticket's detail.
 *
 * /support            → ticket list (grouped by project)
 * /support/:ticketId  → list + the ticket's reports, links and timeline
 */

import { useCallback, useEffect, useState } from "react";
import { navigate, useGatewayClient } from "@anima/ui";

// ── Types (mirror extensions/support/src/store.ts) ───────────

type Status = "new" | "triaged" | "in_progress" | "waiting" | "fixed" | "closed";
type Priority = "urgent" | "high" | "normal" | "low";
type Filter = "open" | "needs_reply" | "fixed" | "closed" | "all";

interface Ticket {
  id: number;
  workspaceId: string | null;
  workspaceName: string | null;
  title: string;
  summary: string | null;
  status: Status;
  priority: Priority;
  trusted: boolean;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
  reportCount: number;
  replyOwed: number;
}

interface Report {
  id: number;
  source: string;
  reporterName: string | null;
  reporterEmail: string | null;
  url: string | null;
  summary: string | null;
  trusted: boolean;
  receivedAt: string;
  repliedAt: string | null;
}

interface Link {
  id: number;
  kind: string;
  ref: string;
  url: string | null;
  title: string | null;
  state: string;
}

interface Activity {
  id: number;
  at: string;
  actor: string;
  kind: string;
  note: string | null;
}

interface Detail {
  ticket: Ticket;
  reports: Report[];
  links: Link[];
  activity: Activity[];
}

// ── Helpers ──────────────────────────────────────────────────

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "needs_reply", label: "Needs reply" },
  { id: "fixed", label: "Fixed" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const STATUSES: Status[] = ["new", "triaged", "in_progress", "waiting", "fixed", "closed"];

const STATUS_STYLE: Record<Status, string> = {
  new: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  triaged: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  in_progress: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  waiting: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  fixed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  closed: "bg-zinc-700/30 text-zinc-500 border-zinc-600/30",
};

const PRIORITY_DOT: Record<Priority, string> = {
  urgent: "bg-rose-500",
  high: "bg-orange-400",
  normal: "bg-zinc-400",
  low: "bg-zinc-600",
};

function age(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) {
    const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
    return hours < 1 ? "just now" : `${hours}h`;
  }
  return `${days}d`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[11px] ${STATUS_STYLE[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}

// ── Ticket list ──────────────────────────────────────────────

function TicketRow({ ticket, selected }: { ticket: Ticket; selected: boolean }) {
  return (
    <button
      type="button"
      onClick={() => navigate(`/support/${ticket.id}`)}
      className={`w-full text-left px-3 py-2.5 rounded-md border transition-colors ${
        selected
          ? "bg-zinc-800 border-zinc-600"
          : "bg-zinc-900/60 border-zinc-800 hover:border-zinc-700"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[ticket.priority]}`} />
        <span className="text-xs text-zinc-500 shrink-0">#{ticket.id}</span>
        <span className="text-sm text-zinc-100 truncate">{ticket.title}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-4 text-[11px] text-zinc-500">
        <StatusBadge status={ticket.status} />
        <span>{age(ticket.createdAt)} old</span>
        {ticket.reportCount > 0 && <span>{ticket.reportCount} report(s)</span>}
        {ticket.replyOwed > 0 && (
          <span className="text-rose-300">{ticket.replyOwed} reply owed</span>
        )}
        {!ticket.trusted && !ticket.approved && <span className="text-amber-400">unverified</span>}
      </div>
    </button>
  );
}

function groupByProject(tickets: Ticket[]): Array<[string, Ticket[]]> {
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const key = t.workspaceName ?? "No project";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()].sort(([a], [b]) =>
    a === "No project" ? 1 : b === "No project" ? -1 : a.localeCompare(b),
  );
}

// ── Ticket detail ────────────────────────────────────────────

function TicketDetail({
  detail,
  onStatus,
  onApprove,
  onReplied,
  onNote,
}: {
  detail: Detail;
  onStatus: (status: Status) => void;
  onApprove: () => void;
  onReplied: () => void;
  onNote: (note: string) => void;
}) {
  const { ticket, reports, links, activity } = detail;
  const [note, setNote] = useState("");

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-5">
      <div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>#{ticket.id}</span>
          <span>·</span>
          <span>{ticket.workspaceName ?? "No project"}</span>
          <span>·</span>
          <span>{ticket.priority}</span>
        </div>
        <h2 className="mt-1 text-base font-semibold text-zinc-100">{ticket.title}</h2>
        {ticket.summary && (
          <p className="mt-2 text-sm text-zinc-400 whitespace-pre-wrap">{ticket.summary}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={ticket.status}
          onChange={(e) => onStatus(e.target.value as Status)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </select>
        {!ticket.trusted && !ticket.approved && (
          <button
            type="button"
            onClick={onApprove}
            className="px-2 py-1 rounded text-xs bg-amber-600/80 text-white hover:bg-amber-500"
          >
            Approve
          </button>
        )}
        {ticket.replyOwed > 0 && (
          <button
            type="button"
            onClick={onReplied}
            className="px-2 py-1 rounded text-xs bg-emerald-700/80 text-white hover:bg-emerald-600"
          >
            Mark replied
          </button>
        )}
      </div>

      {reports.length > 0 && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">
            Reports
          </h3>
          <ul className="space-y-2">
            {reports.map((r) => (
              <li key={r.id} className="text-sm">
                <div className="text-zinc-300">
                  <span className="text-zinc-500">{r.source}</span>{" "}
                  {r.reporterName ?? r.reporterEmail ?? "unknown"}
                  {r.reporterEmail && r.reporterName && (
                    <span className="text-zinc-500"> &lt;{r.reporterEmail}&gt;</span>
                  )}
                  <span className="text-zinc-600"> · {when(r.receivedAt)}</span>
                  {r.repliedAt && <span className="text-emerald-400"> · replied</span>}
                  {!r.trusted && <span className="text-amber-400"> · unverified</span>}
                </div>
                {r.summary && <p className="text-zinc-400 text-xs mt-0.5">{r.summary}</p>}
                {r.url && (
                  <a href={r.url} target="_blank" rel="noreferrer" className="text-xs text-sky-400">
                    {r.url}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {links.length > 0 && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">Links</h3>
          <ul className="space-y-1 text-sm">
            {links.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-2 items-baseline">
                <span className="text-zinc-500 text-xs w-14">{l.kind}</span>
                {l.kind === "session" ? (
                  <a
                    href={ticket.workspaceId ? `/chat/${ticket.workspaceId}/${l.ref}` : "/chat"}
                    className="text-sky-400 truncate"
                  >
                    {l.title ?? l.ref}
                  </a>
                ) : l.url ? (
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 truncate"
                  >
                    {l.ref}
                    {l.title ? `: ${l.title}` : ""}
                  </a>
                ) : (
                  <span className="text-zinc-300">{l.ref}</span>
                )}
                <span className="text-xs text-zinc-500">{l.state}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">Timeline</h3>
        <ul className="space-y-1.5">
          {activity.map((a) => (
            <li key={a.id} className="text-xs">
              <span className="text-zinc-600">{when(a.at)}</span>{" "}
              <span className="text-zinc-400">{a.actor}</span>{" "}
              <span className="text-zinc-500">{a.kind}</span>
              {a.note && <div className="text-zinc-300 whitespace-pre-wrap mt-0.5">{a.note}</div>}
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            onNote(note.trim());
            setNote("");
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note…"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200"
          />
          <button
            type="submit"
            className="px-3 py-1 rounded text-xs bg-purple-600 text-white hover:bg-purple-500"
          >
            Add
          </button>
        </form>
      </section>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────

export function SupportPage({ ticketId }: { ticketId?: string }) {
  const { call } = useGatewayClient();
  const [filter, setFilter] = useState<Filter>("open");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedId = ticketId ? Number(ticketId) : null;

  const rpc = useCallback(
    <T = unknown,>(method: string, params?: Record<string, unknown>): Promise<T> =>
      call<T>(method, params, { timeoutMs: 15000 }),
    [call],
  );

  const load = useCallback(async () => {
    try {
      const result = await rpc<{ tickets: Ticket[] }>("support.list_tickets", { filter });
      setTickets(result.tickets);
      setDetail(
        selectedId ? await rpc<Detail>("support.get_ticket", { ticketId: selectedId }) : null,
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rpc, filter, selectedId]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 15000);
    return () => clearInterval(interval);
  }, [load]);

  async function act(method: string, params: Record<string, unknown>) {
    if (!selectedId) return;
    await rpc(method, { ticketId: selectedId, actor: "michael", ...params });
    await load();
  }

  const groups = groupByProject(tickets);

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="mb-5">
          <h1 className="text-xl font-semibold">Support</h1>
          <p className="text-xs text-zinc-500 mt-1">
            Tickets across projects. GitHub issues and PRs are linked, not copied.
          </p>
        </div>

        <div className="flex flex-wrap gap-1 mb-5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1 rounded-full text-xs border ${
                filter === f.id
                  ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && <div className="mb-4 text-sm text-rose-400">{error}</div>}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-6 min-w-0">
            {loading ? (
              <div className="text-sm text-zinc-500 py-12 text-center">Loading tickets…</div>
            ) : groups.length === 0 ? (
              <div className="text-sm text-zinc-500 py-12 text-center">Nothing here. 🌰</div>
            ) : (
              groups.map(([project, list]) => (
                <section key={project}>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">
                    {project} <span className="text-zinc-600">({list.length})</span>
                  </h2>
                  <div className="space-y-2">
                    {list.map((t) => (
                      <TicketRow key={t.id} ticket={t} selected={t.id === selectedId} />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>

          <div className="min-w-0">
            {detail ? (
              <TicketDetail
                detail={detail}
                onStatus={(status) => void act("support.update_ticket", { status })}
                onApprove={() => void act("support.approve", {})}
                onReplied={() => void act("support.mark_replied", {})}
                onNote={(note) => void act("support.note", { note })}
              />
            ) : (
              <div className="hidden lg:block text-sm text-zinc-600 py-12 text-center">
                Pick a ticket to see its reports, links and timeline.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
