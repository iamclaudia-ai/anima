import { formatDuration } from "@anima/shared";

export const SESSION_TIME_REMINDER_THRESHOLD_MS = 3 * 60 * 60 * 1000;

export interface SessionTimeMetadata {
  lastUserMessageAt?: string;
  lastAssistantMessageAt?: string;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Hoist the formatter — constructing it lazily compiles locale data on every
// call, but the options are static so we can build once at module load.
const LOCAL_DATETIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

export function formatLocalDateTime(date: Date): string {
  return LOCAL_DATETIME_FORMATTER.format(date);
}

export function buildSessionStartReminder(now = new Date()): string {
  return [
    "<system-reminder>",
    `Current local date and time: ${formatLocalDateTime(now)}.`,
    "Use this as the session start time for temporal context.",
    "</system-reminder>",
  ].join("\n");
}

export function buildElapsedTimeReminder(params: {
  metadata?: Record<string, unknown> | null;
  now?: Date;
  thresholdMs?: number;
}): string | null {
  const metadata = params.metadata || {};
  const lastAssistantMs = parseTimestamp(metadata.lastAssistantMessageAt);
  if (lastAssistantMs === null) return null;

  const now = params.now || new Date();
  const elapsedMs = now.getTime() - lastAssistantMs;
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < (params.thresholdMs ?? SESSION_TIME_REMINDER_THRESHOLD_MS)
  ) {
    return null;
  }

  const lastAssistantAt = new Date(lastAssistantMs);
  const lines = [
    "<system-reminder>",
    `Current local date and time: ${formatLocalDateTime(now)}.`,
    `Time since last assistant message: ${formatDuration(elapsedMs)}.`,
    `Last assistant message time: ${formatLocalDateTime(lastAssistantAt)}.`,
  ];
  lines.push("</system-reminder>");
  return lines.join("\n");
}

export function withTimeReminder(
  content: string | unknown[],
  reminder: string | null,
): string | unknown[] {
  if (!reminder) return content;
  if (typeof content === "string") {
    return `${reminder}\n\n${content}`;
  }
  return [{ type: "text", text: reminder }, ...content];
}
