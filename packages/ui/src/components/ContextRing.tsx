import type { Usage } from "../types";

const MAX_CONTEXT_TOKENS = 200_000;
const RING_CIRCUMFERENCE = 87.96; // 2 * pi * 14 (the ring radius)

interface ContextRingProps {
  usage: Usage | null;
}

/**
 * Small SVG ring that fills with the current context usage percentage and
 * color-codes it (green → orange → red). Renders nothing when usage is null
 * (no model call yet).
 */
export function ContextRing({ usage }: ContextRingProps) {
  if (!usage) return null;
  const total =
    usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const percent = (total / MAX_CONTEXT_TOKENS) * 100;
  const strokeColor =
    percent === 0
      ? "#d1d5db" // gray-300 (lighter gray for zero state)
      : percent >= 80
        ? "#dc2626" // red-600
        : percent >= 60
          ? "#f97316" // orange-500
          : "#10b981"; // emerald-500

  return (
    <div className="absolute bottom-14 right-2 flex flex-col items-center">
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        aria-label={`Context usage: ${Math.round(percent)}%`}
      >
        {/* Background ring (darker gray) */}
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          stroke="#9ca3af"
          strokeWidth="2.5"
          className="transform -rotate-90 origin-center"
          style={{ transformOrigin: "16px 16px" }}
        />
        {/* Progress ring (colored) */}
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          stroke={strokeColor}
          strokeWidth="2.5"
          strokeDasharray={`${(percent / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          strokeLinecap="round"
          className="transform -rotate-90 origin-center"
          style={{ transformOrigin: "16px 16px" }}
        />
        {percent > 0 && (
          <text
            x="16"
            y="16"
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-[9px] font-mono font-semibold fill-gray-600"
          >
            {Math.round(percent)}
          </text>
        )}
      </svg>
    </div>
  );
}
