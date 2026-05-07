/**
 * HeaderSlotsContext — Lets panels (and any descendant component) contribute
 * pieces of UI to the global `AppHeader` chrome.
 *
 * Why a context+hook instead of a static `headerSlots` field on the panel
 * contribution: slot content typically depends on live state (active
 * workspace, connection status, voice on/off). It's cleanest to register
 * from the component that already owns that state.
 *
 * The `id` must be stable across re-renders (use a literal string). Slots
 * with the same `(segment, id)` overwrite each other — so the same panel
 * can swap content without leaking duplicates. Auto-cleanup on unmount.
 *
 * Ordering within a segment: `(order asc, id asc)` so the result is
 * deterministic across mount order. Default `order: 100`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type HeaderSegment = "left" | "center" | "right";

export interface HeaderSlot {
  segment: HeaderSegment;
  id: string;
  order: number;
  content: ReactNode;
}

interface HeaderSlotsContextValue {
  slots: HeaderSlot[];
  register(slot: HeaderSlot): void;
  unregister(segment: HeaderSegment, id: string): void;
}

const HeaderSlotsContext = createContext<HeaderSlotsContextValue | null>(null);

export interface HeaderSlotsProviderProps {
  children: ReactNode;
}

export function HeaderSlotsProvider({ children }: HeaderSlotsProviderProps) {
  const [slots, setSlots] = useState<HeaderSlot[]>([]);

  const register = useCallback((slot: HeaderSlot) => {
    setSlots((prev) => {
      // Drop any existing entry with the same (segment, id) so a re-render
      // with new content replaces cleanly instead of stacking.
      const filtered = prev.filter((s) => !(s.segment === slot.segment && s.id === slot.id));
      return [...filtered, slot];
    });
  }, []);

  const unregister = useCallback((segment: HeaderSegment, id: string) => {
    setSlots((prev) => prev.filter((s) => !(s.segment === segment && s.id === id)));
  }, []);

  const value = useMemo<HeaderSlotsContextValue>(
    () => ({ slots, register, unregister }),
    [slots, register, unregister],
  );

  return <HeaderSlotsContext.Provider value={value}>{children}</HeaderSlotsContext.Provider>;
}

export interface UseHeaderSlotOptions {
  /** Lower numbers render first within a segment. Defaults to 100. */
  order?: number;
}

/**
 * Register a header slot for the lifetime of the calling component.
 *
 * Usage:
 *   useHeaderSlot("center", "chat.workspace", <span>{name}</span>);
 *   useHeaderSlot("right",  "chat.connection", <ConnectionDot />, { order: 90 });
 *
 * No-op (with a console warning in dev) if there's no `HeaderSlotsProvider`
 * above — callers can drop the hook into shared components without
 * worrying about which routes do/don't have a header.
 */
export function useHeaderSlot(
  segment: HeaderSegment,
  id: string,
  content: ReactNode,
  options: UseHeaderSlotOptions = {},
): void {
  const ctx = useContext(HeaderSlotsContext);
  const order = options.order ?? 100;

  useEffect(() => {
    if (!ctx) return;
    ctx.register({ segment, id, order, content });
    return () => {
      ctx.unregister(segment, id);
    };
  }, [ctx, segment, id, order, content]);
}

/** Read all currently-registered header slots. Used by `AppHeader`. */
export function useHeaderSlots(): HeaderSlot[] {
  const ctx = useContext(HeaderSlotsContext);
  return ctx?.slots ?? [];
}
