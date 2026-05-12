/**
 * Anima Client-Side Router
 *
 * Lightweight pushState router — zero dependencies, ~75 lines.
 * Supports :param patterns, back/forward, and Link components.
 */

import { createContext, use, useState, useEffect, useCallback, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { LayoutDefinition, LayoutNode } from "@anima/shared";
import type { PanelDefinition } from "@anima/shared";
import type { PanelRegistry } from "./components/LayoutManager";
import { LayoutManager } from "./components/LayoutManager";
import { AppHeader } from "./components/AppHeader";
import { useIsMobile } from "./hooks/useIsMobile";

// ── Types ────────────────────────────────────────────────────

export interface Route {
  path: string;
  // biome-ignore lint: Page components have varying prop signatures from route params
  component?: ComponentType<any>;
  /** Named layout to use instead of a single component (e.g., "ide") */
  layout?: string;
  label?: string;
  /** Browser tab title — shown as "title — Anima". Falls back to label. */
  title?: string;
  /**
   * When true, suppress the global `AppHeader` chrome on this route. Use
   * for pages that own their own visual identity (e.g., the home-page
   * launcher) or that need full-bleed content. Defaults to false — every
   * other route gets the global header.
   */
  hideAppHeader?: boolean;
}

export interface PanelContribution extends PanelDefinition {
  /** React component to render in this panel. */
  // biome-ignore lint: Panel components have varying prop signatures from extension pages
  component: ComponentType<any>;
}

/**
 * Color theme for an extension's launcher tile on the gateway home page.
 *
 * Each field is a literal Tailwind class string — no central palette,
 * no enum, no mapping table. Pick whatever colors fit your extension.
 * The home page slots the classes in directly; Tailwind picks them up
 * via the `@source "extensions/.../*.tsx"` content scan in
 * `packages/ui/src/styles/index.css`, so any class you write in your
 * `routes.ts` ships in the SPA bundle.
 *
 * Conventional template (replace `<color>` with violet, rose, teal, …):
 *   {
 *     iconBg: "bg-<color>-100",
 *     iconColor: "text-<color>-600",
 *     ring: "ring-<color>-200/70",
 *     hoverText: "group-hover:text-<color>-700",
 *   }
 */
export interface LauncherColor {
  /** Tailwind class for the icon-square background. */
  iconBg: string;
  /** Tailwind class for the icon stroke. */
  iconColor: string;
  /** Tailwind class for the icon-square ring. */
  ring: string;
  /** Tailwind class for the label color on hover. */
  hoverText: string;
}

export interface ExtensionWebContribution {
  /** Extension ID that owns this browser contribution. */
  id: string;
  /**
   * Display name. Used as the label on the gateway home page launcher
   * tile, so make it pretty (e.g., "Claudia" rather than "Chat").
   */
  name?: string;
  /** Stable ordering hint for route/panel aggregation. Lower values sort first. */
  order?: number;
  /** Allows a contribution module to exist without being mounted yet. */
  enabled?: boolean;
  /**
   * Lucide icon shown on the gateway home page (`/`) launcher tile.
   * The tile links to the **first route** in the `routes` array.
   * Without an icon, the extension gets no launcher tile — useful for
   * dev-only or panel-only contributions.
   */
  icon?: LucideIcon;
  /**
   * Launcher tile color theme. Defaults to a neutral stone tone if
   * omitted. Pick whatever Tailwind classes fit the extension's vibe.
   */
  color?: LauncherColor;
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

/** Match "/chat/:workspaceId" against "/chat/ws_abc" → { workspaceId: "ws_abc" } */
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
  return use(RouterContext);
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

interface RouterProps {
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
              {wrapWithChrome(
                route,
                <LayoutManager
                  registry={panelRegistry}
                  layout={layoutNode}
                  storageKey={`layout:${route.layout}:${isMobile ? "mobile" : "desktop"}`}
                  provider={layoutDef.provider}
                />,
              )}
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
            {wrapWithChrome(route, <Component {...params} />)}
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

/**
 * Wrap a route's content with the global `AppHeader` chrome unless the
 * route opted out via `hideAppHeader: true`. The chrome installs a
 * full-viewport flex column so the header gets its natural height and the
 * content fills the rest.
 */
function wrapWithChrome(route: Route, content: ReactNode): ReactNode {
  if (route.hideAppHeader) return content;
  return (
    <div className="flex h-screen flex-col bg-white">
      <AppHeader />
      <main className="min-h-0 flex-1 bg-white">{content}</main>
    </div>
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
