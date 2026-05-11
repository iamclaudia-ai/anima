/**
 * Memory Calendar Page
 *
 * A heatmap-style calendar showing conversation activity by day.
 * Light, warm, airy aesthetic — soft violet/rose accents on cream.
 * Click a day to drill into the timeline view.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "@anima/ui";
import { useGatewayRpc } from "../hooks/useGatewayRpc";

// ── Types ────────────────────────────────────────────────────

interface CalendarDay {
  date: string;
  conversationCount: number;
  totalEntries: number;
  archivedCount: number;
}

interface MonthRange {
  earliest: string | null;
  latest: string | null;
}

// ── Helpers ──────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

function formatMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-");
  return `${MONTHS[parseInt(month, 10) - 1]} ${year}`;
}

function getDaysInMonth(yearMonth: string): number {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

function getFirstDayOfWeek(yearMonth: string): number {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(year, month - 1, 1).getDay();
}

function prevMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, "0")}`;
}

function nextMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10);
}

/** Map conversation count to an intensity level 0-4 */
function getIntensity(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 10) return 3;
  return 4;
}

// ── Calendar Cell ────────────────────────────────────────────

function CalendarCell({
  date,
  day,
  dayData,
  isCurrentMonth,
}: {
  date: string;
  day: number;
  dayData: CalendarDay | undefined;
  isCurrentMonth: boolean;
}) {
  const count = dayData?.conversationCount ?? 0;
  const entries = dayData?.totalEntries ?? 0;
  const intensity = getIntensity(count);
  const today = isToday(date);

  // Light mode intensity styles — soft violet washes
  const intensityStyles = [
    // 0: empty
    "bg-white border-stone-200/60",
    // 1: whisper
    "bg-violet-50/60 border-violet-200/40",
    // 2: soft
    "bg-violet-100/50 border-violet-200/50",
    // 3: warm
    "bg-violet-100/70 border-violet-300/50",
    // 4: rich
    "bg-violet-200/50 border-violet-300/60",
  ];

  const cellContent = (
    <div
      className={`
        relative group aspect-square rounded-xl border transition-all duration-300 p-2 flex flex-col
        ${isCurrentMonth ? intensityStyles[intensity] : "bg-stone-50/40 border-stone-200/30 opacity-40"}
        ${today ? "ring-2 ring-violet-400/50 ring-offset-1 ring-offset-stone-50" : ""}
        ${count > 0 && isCurrentMonth ? "hover:scale-[1.04] hover:shadow-md hover:border-violet-400/50 cursor-pointer" : ""}
      `}
    >
      {/* Day number */}
      <span
        className={`
          text-xs font-medium leading-none
          ${today ? "text-violet-600 font-semibold" : isCurrentMonth ? "text-stone-500" : "text-stone-300"}
        `}
      >
        {day}
      </span>

      {/* Activity indicator */}
      {count > 0 && isCurrentMonth && (
        <div className="flex-1 flex items-end justify-between">
          <div className="flex gap-0.5 items-end">
            {Array.from({ length: Math.min(count, 6) }).map((_, i) => (
              <div
                key={i}
                className="w-1 rounded-full bg-violet-400/70"
                style={{
                  height: `${Math.max(4, Math.min(16, (entries / count) * 0.8))}px`,
                  opacity: 0.3 + (i / Math.min(count, 6)) * 0.7,
                }}
              />
            ))}
          </div>
          <span className="text-[10px] text-violet-500/70 font-medium">{count}</span>
        </div>
      )}

      {/* Tooltip on hover */}
      {count > 0 && isCurrentMonth && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 rounded-lg bg-white border border-stone-200 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 whitespace-nowrap">
          <span className="text-xs text-stone-600">
            <strong className="text-violet-600">{count}</strong> conversation
            {count !== 1 ? "s" : ""}
            {" · "}
            <span className="text-stone-400">{entries} messages</span>
          </span>
        </div>
      )}
    </div>
  );

  if (count > 0 && isCurrentMonth) {
    return (
      <Link to={`/memory/day/${date}`} className="no-underline">
        {cellContent}
      </Link>
    );
  }

  return cellContent;
}

// ── Stats Bar ────────────────────────────────────────────────

function MonthStats({ days }: { days: CalendarDay[] }) {
  const totalConversations = days.reduce((sum, d) => sum + d.conversationCount, 0);
  const totalEntries = days.reduce((sum, d) => sum + d.totalEntries, 0);
  const activeDays = days.filter((d) => d.conversationCount > 0).length;
  const archivedCount = days.reduce((sum, d) => sum + d.archivedCount, 0);

  const stats = [
    { label: "Conversations", value: totalConversations, accent: "text-violet-600" },
    { label: "Messages", value: totalEntries.toLocaleString(), accent: "text-stone-700" },
    { label: "Active Days", value: activeDays, accent: "text-stone-700" },
    { label: "Archived", value: archivedCount, accent: "text-emerald-600" },
  ];

  return (
    <div className="flex gap-6 flex-wrap">
      {stats.map((stat) => (
        <div key={stat.label} className="flex items-baseline gap-1.5">
          <span className={`text-lg font-semibold tabular-nums ${stat.accent}`}>{stat.value}</span>
          <span className="text-xs text-stone-400">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main Page Component ──────────────────────────────────────

export function MemoryCalendarPage() {
  const { request, connected } = useGatewayRpc();
  const [currentMonth, setCurrentMonth] = useState(getCurrentMonth);
  const [calendarData, setCalendarData] = useState<CalendarDay[]>([]);
  const [monthRange, setMonthRange] = useState<MonthRange>({ earliest: null, latest: null });
  const [loading, setLoading] = useState(true);

  // Fetch calendar data for current month
  const fetchCalendar = useCallback(async () => {
    if (!connected) return;
    try {
      const data = await request<{ month: string; days: CalendarDay[] }>("memory.calendar", {
        month: currentMonth,
      });
      setCalendarData(data.days);
    } catch (error) {
      console.error("[MemoryCalendar] Failed to fetch:", error);
    } finally {
      setLoading(false);
    }
  }, [connected, request, currentMonth]);

  // Fetch month range on mount
  useEffect(() => {
    if (!connected) return;
    request<MonthRange>("memory.month_range").then(setMonthRange).catch(console.error);
  }, [connected, request]);

  useEffect(() => {
    setLoading(true);
    fetchCalendar();
  }, [fetchCalendar]);

  // Build calendar grid
  const calendarGrid = useMemo(() => {
    const daysInMonth = getDaysInMonth(currentMonth);
    const firstDay = getFirstDayOfWeek(currentMonth);
    const dataMap = new Map(calendarData.map((d) => [d.date, d]));

    const cells: Array<{ date: string; day: number; isCurrentMonth: boolean; data?: CalendarDay }> =
      [];

    // Previous month padding
    const prevMonthStr = prevMonth(currentMonth);
    const prevMonthDays = getDaysInMonth(prevMonthStr);
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = prevMonthDays - i;
      const date = `${prevMonthStr}-${String(day).padStart(2, "0")}`;
      cells.push({ date, day, isCurrentMonth: false });
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${currentMonth}-${String(day).padStart(2, "0")}`;
      cells.push({ date, day, isCurrentMonth: true, data: dataMap.get(date) });
    }

    // Next month padding (fill to complete the last week)
    const nextMonthStr = nextMonth(currentMonth);
    const remaining = 7 - (cells.length % 7);
    if (remaining < 7) {
      for (let day = 1; day <= remaining; day++) {
        const date = `${nextMonthStr}-${String(day).padStart(2, "0")}`;
        cells.push({ date, day, isCurrentMonth: false });
      }
    }

    return cells;
  }, [currentMonth, calendarData]);

  const canGoPrev = !monthRange.earliest || currentMonth > monthRange.earliest.slice(0, 7);
  const canGoNext = currentMonth < getCurrentMonth();

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      {/* Soft gradient wash */}
      <div className="absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-violet-50/50 to-transparent pointer-events-none" />

      {/* Header */}
      <div className="relative border-b border-stone-200/80 px-6 py-5">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-3 mb-1">
            <Link to="/" className="text-stone-400 hover:text-stone-600 transition-colors">
              &larr;
            </Link>
            <div className="flex items-center gap-2">
              <div className="size-2 rounded-full bg-violet-400 animate-pulse" />
              <h1
                className="text-xl tracking-tight text-stone-700"
                style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
              >
                Memory
              </h1>
            </div>
          </div>
          <p className="text-sm text-stone-400 ml-7">A living archive of every conversation</p>
        </div>
      </div>

      {/* Content */}
      <div className="relative max-w-4xl mx-auto px-6 py-8">
        {/* Month Navigation */}
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => canGoPrev && setCurrentMonth(prevMonth(currentMonth))}
            disabled={!canGoPrev}
            className={`
              flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-all
              ${
                canGoPrev
                  ? "text-stone-500 hover:text-stone-700 hover:bg-white hover:shadow-sm"
                  : "text-stone-300 cursor-not-allowed"
              }
            `}
          >
            <span className="text-lg leading-none">&lsaquo;</span>
            <span>Prev</span>
          </button>

          <div className="text-center">
            <h2
              className="text-2xl text-stone-700 tracking-tight"
              style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
            >
              {formatMonth(currentMonth)}
            </h2>
            {!loading && <MonthStats days={calendarData} />}
          </div>

          <button
            onClick={() => canGoNext && setCurrentMonth(nextMonth(currentMonth))}
            disabled={!canGoNext}
            className={`
              flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-all
              ${
                canGoNext
                  ? "text-stone-500 hover:text-stone-700 hover:bg-white hover:shadow-sm"
                  : "text-stone-300 cursor-not-allowed"
              }
            `}
          >
            <span>Next</span>
            <span className="text-lg leading-none">&rsaquo;</span>
          </button>
        </div>

        {/* Calendar Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="flex items-center gap-3 text-stone-400">
              <div className="size-4 border-2 border-violet-300 border-t-violet-500 rounded-full animate-spin" />
              <span className="text-sm">Loading memories...</span>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-2 mb-1">
              {WEEKDAYS.map((day) => (
                <div key={day} className="text-center text-xs text-stone-400 font-medium py-1">
                  {day}
                </div>
              ))}
            </div>

            {/* Calendar cells */}
            <div className="grid grid-cols-7 gap-2">
              {calendarGrid.map((cell) => (
                <CalendarCell
                  key={cell.date}
                  date={cell.date}
                  day={cell.day}
                  dayData={cell.data}
                  isCurrentMonth={cell.isCurrentMonth}
                />
              ))}
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="mt-8 flex items-center justify-center gap-2">
          <span className="text-xs text-stone-400">Less</span>
          {[0, 1, 2, 3, 4].map((level) => {
            const styles = [
              "bg-white border-stone-200/60",
              "bg-violet-50/60 border-violet-200/40",
              "bg-violet-100/50 border-violet-200/50",
              "bg-violet-100/70 border-violet-300/50",
              "bg-violet-200/50 border-violet-300/60",
            ];
            return <div key={level} className={`size-4 rounded border ${styles[level]}`} />;
          })}
          <span className="text-xs text-stone-400">More</span>
        </div>

        {/* Quick navigation to months */}
        {monthRange.earliest && (
          <div className="mt-10 pt-6 border-t border-stone-200/60">
            <h3 className="text-xs text-stone-400 uppercase tracking-wider mb-3">Archive</h3>
            <div className="flex flex-wrap gap-1.5">
              {generateMonthList(monthRange.earliest.slice(0, 7), getCurrentMonth()).map((m) => (
                <button
                  key={m}
                  onClick={() => setCurrentMonth(m)}
                  className={`
                    px-2.5 py-1 rounded-md text-xs transition-all
                    ${
                      m === currentMonth
                        ? "bg-violet-100 text-violet-700 border border-violet-200/60 font-medium"
                        : "text-stone-400 hover:text-stone-600 hover:bg-white hover:shadow-sm"
                    }
                  `}
                >
                  {MONTHS[parseInt(m.split("-")[1], 10) - 1].slice(0, 3)} {m.split("-")[0].slice(2)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Generate a list of YYYY-MM strings between two months */
function generateMonthList(from: string, to: string): string[] {
  const months: string[] = [];
  let current = from;
  while (current <= to) {
    months.push(current);
    current = nextMonth(current);
  }
  return months;
}
