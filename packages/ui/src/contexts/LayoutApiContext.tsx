/**
 * LayoutApiContext — Publishes the active dockview `DockviewApi` so panels
 * (and their slot contributions in `AppHeader`) can drive layout changes
 * imperatively: add/remove panels, set sizes, listen for layout events.
 *
 * Wired by `LayoutManager` — it captures `event.api` in `onReady` and
 * clears it on unmount. Consumers read it through `useLayoutApi()` and
 * should treat `null` as "no layout mounted" (e.g., on a component-only
 * route).
 */

import { createContext, use, useState, type ReactNode } from "react";
import type { DockviewApi } from "dockview-react";

interface LayoutApiContextValue {
  api: DockviewApi | null;
  setApi: (api: DockviewApi | null) => void;
}

const LayoutApiContext = createContext<LayoutApiContextValue | null>(null);

export interface LayoutApiProviderProps {
  children: ReactNode;
}

export function LayoutApiProvider({ children }: LayoutApiProviderProps) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  return <LayoutApiContext.Provider value={{ api, setApi }}>{children}</LayoutApiContext.Provider>;
}

/**
 * Returns the active dockview `DockviewApi`, or `null` when no layout
 * is mounted. Use it from any panel (or any descendant of `LayoutManager`)
 * to reach into the dock — toggle visibility, resize panels, subscribe
 * to layout events, etc.
 */
export function useLayoutApi(): DockviewApi | null {
  const ctx = use(LayoutApiContext);
  return ctx?.api ?? null;
}

/**
 * Internal — used by `LayoutManager` to publish its api into the context.
 * Not exported from `@anima/ui` because no other code should be writing
 * here.
 */
export function useSetLayoutApi(): (api: DockviewApi | null) => void {
  const ctx = use(LayoutApiContext);
  return ctx?.setApi ?? (() => {});
}
