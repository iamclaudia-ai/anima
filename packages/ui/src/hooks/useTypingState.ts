import { useCallback, useRef, useState } from "react";

const TYPING_IDLE_MS = 2_000;

/**
 * Track whether the user is actively typing, with an idle timeout. Bogart
 * uses this to perk up / settle down.
 *
 * Returns `{ isTyping, ping }`. Call `ping()` from your input handler on every
 * keystroke; `isTyping` flips false after `TYPING_IDLE_MS` of no pings.
 */
export function useTypingState(): { isTyping: boolean; ping: () => void } {
  const [isTyping, setIsTyping] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ping = useCallback(() => {
    setIsTyping(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsTyping(false), TYPING_IDLE_MS);
  }, []);

  return { isTyping, ping };
}
