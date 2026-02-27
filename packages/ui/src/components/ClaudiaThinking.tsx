/**
 * ClaudiaThinking - Animated thinking indicator with circuit brain
 * Event-driven animation that advances with each agent event
 */

import ThinkingFrame from "./ThinkingFrame";

interface ClaudiaThinkingProps {
  count?: number;
  streamCount?: number;
  simulatedCount?: number;
  showCounters?: boolean;
  size?: "sm" | "md" | "lg";
  speed?: number;
  isActive?: boolean;
  inactivityTimeout?: number;
}

export function ClaudiaThinking({
  count = 0,
  streamCount = 0,
  simulatedCount = 0,
  showCounters = true,
  size = "md",
  speed = 1,
  isActive = true,
  inactivityTimeout = 60000,
}: ClaudiaThinkingProps) {
  const adjustedCount = Math.floor(count / speed);
  const sizeClasses = {
    sm: "w-12 h-12",
    md: "w-24 h-24",
    lg: "w-32 h-32",
  };

  return (
    <div className="flex flex-col items-center justify-center gap-1">
      <ThinkingFrame
        count={adjustedCount}
        isActive={isActive}
        inactivityTimeout={inactivityTimeout}
        className={`${sizeClasses[size]} transition-opacity duration-100`}
      />
      {showCounters && (
        <div className="text-xs font-medium text-blue-700 tabular-nums select-none">
          <span className="mr-2">💜 {streamCount}</span>
          <span>🔵 {simulatedCount}</span>
        </div>
      )}
    </div>
  );
}
