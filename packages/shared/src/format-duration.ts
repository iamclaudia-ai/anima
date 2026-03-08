const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DURATION_UNITS = [
  { label: "d", value: MS_PER_DAY },
  { label: "h", value: MS_PER_HOUR },
  { label: "m", value: MS_PER_MINUTE },
  { label: "s", value: MS_PER_SECOND },
  { label: "ms", value: 1 },
] as const;

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "0ms";

  let remaining = Math.max(0, Math.floor(ms));
  if (remaining === 0) return "0ms";

  const parts: string[] = [];
  for (const unit of DURATION_UNITS) {
    if (remaining < unit.value) continue;
    const amount = Math.floor(remaining / unit.value);
    remaining %= unit.value;
    parts.push(`${amount}${unit.label}`);
  }

  return parts.slice(0, 2).join(" ");
}
