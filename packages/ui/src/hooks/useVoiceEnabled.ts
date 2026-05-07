/**
 * useVoiceEnabled — Shared pub/sub store + hook for the "voice on/off" flag.
 *
 * The toggle UI lives in the global `AppHeader` (registered via a header slot
 * from `ChatPanel`), but the value is consumed by `ChatInner` to drive the
 * `voice.speak` request tag passed to `useChatGateway`. Both need to see the
 * same value and react to changes — so we keep the source of truth in a
 * module-scoped variable, persist to `localStorage`, and notify subscribers
 * synchronously when it flips.
 *
 * Same-tab sync is enough for our use case (no cross-tab `storage` listener);
 * if we ever open the app in two tabs we'll add it then.
 */
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "anima:voice";

const subscribers = new Set<() => void>();

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let currentValue = readInitial();

function setValue(next: boolean): void {
  if (next === currentValue) return;
  currentValue = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* noop */
  }
  for (const fn of subscribers) fn();
}

/**
 * Returns `[enabled, toggle]`. Components re-render when the value changes
 * regardless of which component called `toggle`.
 */
export function useVoiceEnabled(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(currentValue);

  useEffect(() => {
    const sync = () => setEnabled(currentValue);
    subscribers.add(sync);
    // Catch any updates that happened between the initial render and effect mount.
    sync();
    return () => {
      subscribers.delete(sync);
    };
  }, []);

  const toggle = useCallback(() => {
    setValue(!currentValue);
  }, []);

  return [enabled, toggle];
}
