/**
 * Day Timeline Page
 *
 * Shows all conversations for a specific day in a vertical timeline.
 * Light, warm aesthetic with soft violet accents.
 * Summaries rendered as markdown for rich formatting.
 */

import { useState, useEffect, useCallback } from "react";
import { Link } from "@anima/ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useGatewayRpc } from "../hooks/useGatewayRpc";

// ── Types ────────────────────────────────────────────────────

interface Conversation {
  id: number;
  sessionId: string;
  sourceFile: string;
  firstMessageAt: string;
  lastMessageAt: string;
  entryCount: number;
  status: string;
  summary: string | null;
  metadata: string | null;
}

// ── Helpers ──────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatDateFull(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[month - 1]} ${day}, ${year}`;
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 0) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
}

function extractCwd(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed.cwd ?? null;
  } catch {
    return null;
  }
}

function shortenCwd(cwd: string): string {
  return cwd
    .replace(/^\/Users\/\w+/, "~")
    .replace(/\/Projects\//, "/")
    .split("/")
    .slice(-2)
    .join("/");
}

const statusConfig: Record<string, { label: string; color: string; dot: string }> = {
  archived: { label: "Archived", color: "text-emerald-600", dot: "bg-emerald-400" },
  active: { label: "Active", color: "text-blue-600", dot: "bg-blue-400" },
  processing: { label: "Processing", color: "text-amber-600", dot: "bg-amber-400 animate-pulse" },
  queued: { label: "Queued", color: "text-yellow-600", dot: "bg-yellow-400" },
  ready: { label: "Ready", color: "text-stone-500", dot: "bg-stone-400" },
};

// ── Timeline Card ────────────────────────────────────────────

function TimelineCard({
  conversation,
  index,
  total,
}: {
  conversation: Conversation;
  index: number;
  total: number;
}) {
  const cwd = extractCwd(conversation.metadata);
  const status = statusConfig[conversation.status] ?? {
    label: conversation.status,
    color: "text-stone-500",
    dot: "bg-stone-400",
  };
  const isLast = index === total - 1;

  return (
    <div className="relative flex gap-6">
      {/* Timeline spine */}
      <div className="flex flex-col items-center w-16 shrink-0">
        {/* Time label */}
        <span className="text-xs font-medium text-violet-500 tabular-nums mb-2 whitespace-nowrap">
          {formatTime(conversation.firstMessageAt)}
        </span>

        {/* Dot */}
        <div className="relative">
          <div className={`size-3 rounded-full ${status.dot} z-10 relative shadow-sm`} />
        </div>

        {/* Connecting line */}
        {!isLast && (
          <div className="flex-1 w-px mt-2 bg-gradient-to-b from-violet-200 to-stone-200/50 min-h-[2rem]" />
        )}
      </div>

      {/* Card */}
      <div
        className={`
          flex-1 mb-6 rounded-xl border border-stone-200/80 bg-white p-5
          shadow-sm transition-all duration-300
          hover:shadow-md hover:border-violet-200/60
          group
        `}
        style={{
          animationDelay: `${index * 80}ms`,
          animation: "fadeSlideUp 0.4s ease-out both",
        }}
      >
        {/* Card header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] uppercase tracking-wider font-semibold ${status.color}`}>
              {status.label}
            </span>
            <span className="text-stone-300">·</span>
            <span className="text-xs text-stone-400 tabular-nums">#{conversation.id}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-stone-400">
            <span className="tabular-nums">{conversation.entryCount} messages</span>
            <span className="text-stone-300">·</span>
            <span className="tabular-nums">
              {formatDuration(conversation.firstMessageAt, conversation.lastMessageAt)}
            </span>
          </div>
        </div>

        {/* Summary — rendered as markdown */}
        {conversation.summary ? (
          // `bg-violet-50` is `prose-code:bg-violet-50` for inline code only;
          // stone text sits on the parent's white card background.
          // react-doctor-disable-next-line react-doctor/no-gray-on-colored-background
          <div className="text-sm text-stone-600 leading-relaxed mb-3 line-clamp-4 prose prose-sm prose-stone max-w-none prose-p:my-1 prose-strong:text-stone-700 prose-code:text-violet-600 prose-code:bg-violet-50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-[''] prose-code:after:content-['']">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{conversation.summary}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-stone-400 italic mb-3">
            No summary yet — conversation may still be active
          </p>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between">
          {cwd && (
            <div className="flex items-center gap-1.5">
              <svg className="size-3 text-stone-400" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <span className="text-xs text-stone-400 font-mono">{shortenCwd(cwd)}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-stone-300 tabular-nums">
              {formatTime(conversation.firstMessageAt)} — {formatTime(conversation.lastMessageAt)}
            </span>
            {conversation.status === "archived" && conversation.summary && (
              <Link
                to={`/memory/episode/${conversation.id}`}
                className="text-xs text-violet-400 hover:text-violet-600 transition-colors opacity-0 group-hover:opacity-100"
              >
                View episode &rarr;
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page Component ──────────────────────────────────────

export function DayTimelinePage({ date }: { date: string }) {
  const { request, connected } = useGatewayRpc();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDay = useCallback(async () => {
    if (!connected) return;
    try {
      const data = await request<{ conversations: Conversation[] }>("memory.day", { date });
      setConversations(data.conversations);
    } catch (error) {
      console.error("[DayTimeline] Failed to fetch:", error);
    } finally {
      setLoading(false);
    }
  }, [connected, request, date]);

  useEffect(() => {
    setLoading(true);
    fetchDay();
  }, [fetchDay]);

  const totalEntries = conversations.reduce((sum, c) => sum + c.entryCount, 0);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      {/* Soft gradient */}
      <div className="absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-violet-50/40 to-transparent pointer-events-none" />

      {/* Keyframes */}
      <style>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Header */}
      <div className="relative border-b border-stone-200/80 px-6 py-5">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <Link to="/memory" className="text-stone-400 hover:text-stone-600 transition-colors">
              &larr;
            </Link>
            <div className="flex items-center gap-2">
              <div className="size-2 rounded-full bg-violet-400" />
              <h1
                className="text-xl tracking-tight text-stone-700"
                style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
              >
                {formatDateFull(date)}
              </h1>
            </div>
          </div>
          {!loading && (
            <div className="ml-7 flex items-center gap-4 text-sm text-stone-400">
              <span>
                <strong className="text-stone-600">{conversations.length}</strong> conversation
                {conversations.length !== 1 ? "s" : ""}
              </span>
              <span className="text-stone-300">·</span>
              <span>
                <strong className="text-stone-600">{totalEntries}</strong> messages
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="relative max-w-3xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="flex items-center gap-3 text-stone-400">
              <div className="size-4 border-2 border-violet-300 border-t-violet-500 rounded-full animate-spin" />
              <span className="text-sm">Loading timeline...</span>
            </div>
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-stone-400">No conversations found for this day</p>
            <Link
              to="/memory"
              className="text-sm text-violet-500 hover:text-violet-600 mt-3 inline-block"
            >
              Back to calendar
            </Link>
          </div>
        ) : (
          <div>
            {conversations.map((conv, i) => (
              <TimelineCard
                key={conv.id}
                conversation={conv}
                index={i}
                total={conversations.length}
              />
            ))}

            {/* End marker */}
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-center w-16 shrink-0">
                <div className="size-2 rounded-full bg-stone-300" />
              </div>
              <p className="text-xs text-stone-400 italic pb-2">
                End of day — {conversations.length} conversation
                {conversations.length !== 1 ? "s" : ""} recorded
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
