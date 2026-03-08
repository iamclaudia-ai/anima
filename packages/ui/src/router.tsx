/**
 * Claudia Client-Side Router
 *
 * Lightweight pushState router — zero dependencies, ~75 lines.
 * Supports :param patterns, back/forward, and Link components.
 */

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ComponentType, ReactNode } from "react";
import type { LayoutDefinition, LayoutNode } from "@claudia/shared";
import type { PanelRegistry } from "./components/LayoutManager";
import { LayoutManager } from "./components/LayoutManager";

// ── Types ────────────────────────────────────────────────────

export interface Route {
  path: string;
  // biome-ignore lint: Page components have varying prop signatures from route params
  component?: ComponentType<any>;
  /** Base directory for static file serving (e.g., "~/romance-novels") */
  static?: string;
  /** Named layout to use instead of a single component (e.g., "ide") */
  layout?: string;
  label?: string;
  icon?: string;
}

interface RouterState {
  pathname: string;
  params: Record<string, string>;
  navigate: (path: string) => void;
}

// ── Path Matching ────────────────────────────────────────────

/** Match "/workspace/:workspaceId" against "/workspace/ws_abc" → { workspaceId: "ws_abc" } */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const paramNames: string[] = [];
  // Support :param* for wildcard (matches rest of path including /)
  const regexStr = pattern.replace(/:([^/]+)(\*)?/g, (_, name, wildcard) => {
    paramNames.push(name);
    return wildcard ? "(.+)" : "([^/]+)";
  });
  const match = new RegExp(`^${regexStr}$`).exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = {};
  paramNames.forEach((name, i) => {
    params[name] = decodeURIComponent(match[i + 1]);
  });
  return params;
}

// ── Navigation ───────────────────────────────────────────────

/** Navigate without full page reload */
export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ── Context ──────────────────────────────────────────────────

const RouterContext = createContext<RouterState>({
  pathname: "/",
  params: {},
  navigate,
});

export function useRouter(): RouterState {
  return useContext(RouterContext);
}

// ── Router Component ─────────────────────────────────────────

/** Determine if current viewport is mobile */
function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);

  return isMobile;
}

export interface RouterProps {
  routes: Route[];
  fallback?: ReactNode;
  /** Layout registry — named layouts from extensions */
  layouts?: Record<string, LayoutDefinition>;
  /** Panel registry — maps panel IDs to components */
  panelRegistry?: PanelRegistry;
}

export function Router({ routes, fallback, layouts, panelRegistry }: RouterProps) {
  const [pathname, setPathname] = useState(window.location.pathname);
  const isMobile = useIsMobile();

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const nav = useCallback((path: string) => navigate(path), []);

  // First match wins (skip static routes - they're handled server-side)
  for (const route of routes) {
    // Skip routes with no component and no layout
    if (!route.component && !route.layout) continue;
    const params = matchPath(route.path, pathname);
    if (params !== null) {
      // Layout-based route
      if (route.layout && layouts && panelRegistry) {
        const layoutDef = layouts[route.layout];
        if (layoutDef) {
          const layoutNode: LayoutNode =
            isMobile && layoutDef.mobile ? layoutDef.mobile : layoutDef.default;
          return (
            <RouterContext.Provider value={{ pathname, params, navigate: nav }}>
              <LayoutManager
                registry={panelRegistry}
                layout={layoutNode}
                storageKey={`layout:${route.layout}:${isMobile ? "mobile" : "desktop"}`}
              />
            </RouterContext.Provider>
          );
        }
      }

      // Component-based route (backward compatible)
      if (route.component) {
        const Component = route.component;
        return (
          <RouterContext.Provider value={{ pathname, params, navigate: nav }}>
            <Component {...params} />
          </RouterContext.Provider>
        );
      }
    }
  }

  return (
    <RouterContext.Provider value={{ pathname, params: {}, navigate: nav }}>
      {fallback ?? null}
    </RouterContext.Provider>
  );
}

// ── Link Component ───────────────────────────────────────────

export function Link({
  to,
  children,
  onClick,
  ...rest
}: { to: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(to);
    onClick?.(e);
  };
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
