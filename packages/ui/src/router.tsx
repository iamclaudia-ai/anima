/**
 * Anima Client-Side Router
 *
 * Lightweight pushState router — zero dependencies, ~75 lines.
 * Supports :param patterns, back/forward, and Link components.
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import type { LayoutDefinition, LayoutNode } from "@anima/shared";
import type { PanelDefinition } from "@anima/shared";
import type { PanelRegistry } from "./components/LayoutManager";
import { LayoutManager } from "./components/LayoutManager";
import { useIsMobile } from "./hooks/useIsMobile";

// ── Types ────────────────────────────────────────────────────

export interface Route {
  path: string;
  // biome-ignore lint: Page components have varying prop signatures from route params
  component?: ComponentType<any>;
  /** Named layout to use instead of a single component (e.g., "ide") */
  layout?: string;
  label?: string;
  icon?: string;
  /** Browser tab title — shown as "title — Anima". Falls back to label. */
  title?: string;
}

export interface PanelContribution extends PanelDefinition {
  /** React component to render in this panel. */
  // biome-ignore lint: Panel components have varying prop signatures from extension pages
  component: ComponentType<any>;
}

export interface ExtensionWebContribution {
  /** Extension ID that owns this browser contribution. */
  id: string;
  /** Optional display name for gateway UI surfaces. */
  name?: string;
  /** Stable ordering hint for route/panel aggregation. Lower values sort first. */
  order?: number;
  /** Allows a contribution module to exist without being mounted yet. */
  enabled?: boolean;
  /** Client-side routes contributed by this extension. */
  routes?: Route[];
  /** Layout panels contributed by this extension. */
  panels?: PanelContribution[];
  /** Named layout definitions contributed by this extension. */
  layouts?: Record<string, LayoutDefinition>;
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

/**
 * Navigate without full page reload. Pass `{ replace: true }` to replace the
 * current history entry instead of pushing a new one — useful for redirects
 * (e.g., resolving `/session/latest` → `/session/<id>`) so the user's back
 * button doesn't bounce them through the placeholder URL.
 */
export function navigate(path: string, options?: { replace?: boolean }): void {
  if (window.location.pathname === path) return;
  if (options?.replace) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
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

// ── Document Title ───────────────────────────────────────────

const BASE_TITLE = "Anima";

function setDocumentTitle(title?: string): void {
  document.title = title ? `${title} — ${BASE_TITLE}` : BASE_TITLE;
}

/**
 * Hook to set a dynamic document title from any page component.
 * Overrides the route's static title. Restores on unmount.
 *
 * Usage: useDocumentTitle("My Workspace")  →  "My Workspace — Anima"
 * Usage: useDocumentTitle(workspace?.name)  →  updates when name changes
 */
export function useDocumentTitle(title: string | undefined | null): void {
  const previousRef = useRef(document.title);

  useEffect(() => {
    const prev = previousRef.current;
    if (title) setDocumentTitle(title);
    return () => {
      document.title = prev;
    };
  }, [title]);
}

// ── Router Component ─────────────────────────────────────────

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
          setDocumentTitle(route.title ?? route.label);
          const layoutNode: LayoutNode =
            isMobile && layoutDef.mobile ? layoutDef.mobile : layoutDef.default;
          return (
            <RouterContext.Provider value={{ pathname, params, navigate: nav }}>
              <LayoutManager
                registry={panelRegistry}
                layout={layoutNode}
                storageKey={`layout:${route.layout}:${isMobile ? "mobile" : "desktop"}`}
                provider={layoutDef.provider}
              />
            </RouterContext.Provider>
          );
        }
      }

      // Component-based route (backward compatible)
      if (route.component) {
        setDocumentTitle(route.title ?? route.label);
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
