import { useCallback, useState } from "react";

/**
 * Track textarea keystrokes as a monotonically increasing signal.
 *
 * Bogart consumes the pulse to wake from sleep/settling and to reset its
 * idle-sleep timeout without tying behavior to machine snapshot changes.
 */
export function useTypingState(): { typingPulse: number; ping: () => void } {
  const [typingPulse, setTypingPulse] = useState(0);

  const ping = useCallback(() => {
    setTypingPulse((pulse) => pulse + 1);
  }, []);

  return { typingPulse, ping };
}
