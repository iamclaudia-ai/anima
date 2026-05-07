/**
 * HeaderSlotsContext — Lets panels (and any descendant component) contribute
 * pieces of UI to the global `AppHeader` chrome.
 *
 * Why a hook instead of a static `headerSlots` field on the panel
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
 *
 * Implementation note — external store
 * ────────────────────────────────────
 * Slot state lives in a module-scoped store (not React state) and is
 * exposed via `useSyncExternalStore`. This is deliberate: if slots were
 * regular `useState`, every `register` call would update the provider's
 * context value, which would re-render every consumer of `useHeaderSlot`
 * (including the panel that just registered). Each re-render produces a
 * new `content` JSX element, the effect's deps change, and we'd churn
 * register/unregister in a tight loop until React threw "Maximum update
 * depth exceeded". With an external store, only the `useHeaderSlots`
 * subscriber (the `AppHeader` itself) re-renders on changes — registrant
 * panels are not pulled along for the ride.
 */

import { useEffect, useSyncExternalStore, type ReactNode } from "react";

export type HeaderSegment = "left" | "center" | "right";

export interface HeaderSlot {
  segment: HeaderSegment;
  id: string;
  order: number;
  content: ReactNode;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: HeaderSlot[] = [];

function emit(): void {
  for (const fn of listeners) fn();
}

function setSlot(slot: HeaderSlot): void {
  const filtered = snapshot.filter((s) => !(s.segment === slot.segment && s.id === slot.id));
  snapshot = [...filtered, slot];
  emit();
}

function removeSlot(segment: HeaderSegment, id: string): void {
  const next = snapshot.filter((s) => !(s.segment === segment && s.id === id));
  if (next.length === snapshot.length) return;
  snapshot = next;
  emit();
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): HeaderSlot[] {
  return snapshot;
}

export interface HeaderSlotsProviderProps {
  children: ReactNode;
}

/**
 * Kept for API compatibility — slots now live in a module-scoped store, so
 * the provider is a no-op pass-through. Mounting it is harmless and makes
 * SPAs that already wrap their tree continue to type-check.
 */
export function HeaderSlotsProvider({ children }: HeaderSlotsProviderProps) {
  return <>{children}</>;
}

export interface UseHeaderSlotOptions {
  /** Lower numbers render first within a segment. Defaults to 100. */
  order?: number;
  /**
   * When `false`, the slot is unregistered (or never registers). Lets a
   * caller toggle a slot on/off — e.g., hiding the editor toggle on
   * mobile where the editor panel isn't part of the layout. Defaults to
   * `true`. Hooks must run unconditionally, so don't put `useHeaderSlot`
   * inside an `if`; use this option instead.
   */
  enabled?: boolean;
}

/**
 * Register a header slot for the lifetime of the calling component.
 *
 * Usage:
 *   useHeaderSlot("center", "chat.workspace", <span>{name}</span>);
 *   useHeaderSlot("right",  "chat.connection", <ConnectionDot />, { order: 90 });
 *   useHeaderSlot("right",  "editor.toggle", <Toggle />, { enabled: !isMobile });
 */
export function useHeaderSlot(
  segment: HeaderSegment,
  id: string,
  content: ReactNode,
  options: UseHeaderSlotOptions = {},
): void {
  const order = options.order ?? 100;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      removeSlot(segment, id);
      return;
    }
    setSlot({ segment, id, order, content });
    return () => {
      removeSlot(segment, id);
    };
  }, [segment, id, order, content, enabled]);
}

/** Read all currently-registered header slots. Used by `AppHeader`. */
export function useHeaderSlots(): HeaderSlot[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
