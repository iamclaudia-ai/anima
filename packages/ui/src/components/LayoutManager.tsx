/**
 * LayoutManager — Renders panel layouts using dockview.
 *
 * Extensions register panels by string ID. Layouts reference those IDs.
 * The LayoutManager resolves IDs → components at runtime via a panel registry.
 * Unresolved panels render a graceful error placeholder.
 *
 * Persistence: dockview's toJSON()/fromJSON() handles layout save/restore.
 * The LayoutManager auto-persists to localStorage keyed by layout name. A
 * structural fingerprint of the layout invalidates stale state when an
 * extension's layout definition changes shape.
 *
 * Per-instance state: `LayoutLeaf.params` flows through to the panel
 * component as React props, so the same panel type can be rendered multiple
 * times in one layout (e.g., two terminals, two chats on different sessions).
 */

import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type DockviewApi,
} from "dockview-react";
import "dockview/dist/styles/dockview.css";
import type { LayoutNode } from "@anima/shared";
import { flattenLayout, layoutFingerprint } from "./layout-flatten";
import { LayoutApiProvider, useSetLayoutApi } from "../contexts/LayoutApiContext";

// ── Panel Registry ──────────────────────────────────────────

export interface PanelRegistration {
  /** Unique panel ID (e.g., "chat.main") */
  id: string;
  /** Display title */
  title: string;
  /** Icon name or emoji */
  icon?: string;
  /**
   * Render strategy — `"always"` keeps the component mounted even when not
   * visible. Required for iframes and stateful components (terminals, video).
   * Default is dockview's `"onlyWhenVisible"`.
   */
  renderer?: "always" | "onlyWhenVisible";
  /** React component to render in this panel */
  // biome-ignore lint: Panel components have varying prop signatures
  component: ComponentType<any>;
}

export type PanelRegistry = Map<string, PanelRegistration>;

// ── Registry Context ────────────────────────────────────────
// Passed via React context (not dockview params) because Maps aren't serializable.

const PanelRegistryContext = createContext<PanelRegistry>(new Map());

// ── Panel Not Found ─────────────────────────────────────────

function PanelNotFound({ panelId }: { panelId: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-zinc-950 text-zinc-500">
      <div className="text-center">
        <p className="text-sm font-medium">Panel not found</p>
        <p className="mt-1 font-mono text-xs text-zinc-600">{panelId}</p>
        <p className="mt-2 text-xs text-zinc-600">
          The extension providing this panel may not be enabled.
        </p>
      </div>
    </div>
  );
}

// ── Dockview Panel Wrapper ──────────────────────────────────

interface PanelWrapperParams {
  panelId: string;
  /** Per-instance params forwarded to the panel component as React props. */
  params?: Record<string, unknown>;
}

/**
 * Wraps a registered panel component for dockview.
 * Resolves the panel component from the registry context at render time and
 * forwards layout-leaf `params` to the component as props.
 */
function PanelWrapper(props: IDockviewPanelProps<PanelWrapperParams>) {
  const { panelId, params } = props.params;
  const registry = useContext(PanelRegistryContext);
  const registration = registry.get(panelId);

  if (!registration) {
    return <PanelNotFound panelId={panelId} />;
  }

  const Component = registration.component;
  return <Component {...(params ?? {})} />;
}

// ── Props ───────────────────────────────────────────────────

export interface LayoutManagerProps {
  /** Panel registry — maps IDs to components */
  registry: PanelRegistry;
  /** Layout tree to render */
  layout: LayoutNode;
  /** Storage key for persisting layout (e.g., "layout:ide") */
  storageKey?: string;
  /** CSS class name */
  className?: string;
  /**
   * Optional wrapper installed around the dockview tree. When the layout
   * comes from `LayoutDefinition.provider`, this lets two panels share
   * state via React context without each panel needing its own gateway
   * subscriptions.
   */
  provider?: ComponentType<{ children: ReactNode }>;
}

// ── Component ───────────────────────────────────────────────

/**
 * Compute a stable React key from the layout structure + storage key. When
 * either changes, React tears down the entire DockviewReact subtree and
 * rebuilds — which is the only reliable way to rebuild the layout, since
 * `onReady` only fires once per dockview instance.
 */
function useLayoutKey(layout: LayoutNode, storageKey: string | undefined): string {
  return useMemo(
    () => `${storageKey ?? "anon"}::${layoutFingerprint(layout)}`,
    [layout, storageKey],
  );
}

export function LayoutManager(props: LayoutManagerProps) {
  // The api setter lives in LayoutApiContext, so the inner component has
  // to be a child of the provider — wrap and delegate.
  return (
    <LayoutApiProvider>
      <LayoutManagerInner {...props} />
    </LayoutApiProvider>
  );
}

function LayoutManagerInner({
  registry,
  layout,
  storageKey,
  className,
  provider: Provider,
}: LayoutManagerProps) {
  // Dockview components map — single wrapper that resolves via registry.
  const components = useMemo(() => ({ "panel-wrapper": PanelWrapper }), []);
  const setLayoutApi = useSetLayoutApi();

  const buildLayout = useCallback(
    (api: DockviewApi) => {
      const requests = flattenLayout(layout);

      for (const req of requests) {
        const registration = registry.get(req.panelId);
        const title = registration?.title ?? req.panelId;
        const renderer = registration?.renderer;

        const addOptions: Parameters<typeof api.addPanel>[0] = {
          id: req.id,
          component: "panel-wrapper",
          title,
          params: { panelId: req.panelId, params: req.params },
          // Dockview accepts the renderer hint per-panel; undefined = its default.
          renderer,
          initialWidth: req.size,
          initialHeight: req.size,
        };

        if (req.referencePanel && req.direction) {
          const refPanel = api.getPanel(req.referencePanel);
          if (refPanel) {
            addOptions.position = {
              referencePanel: refPanel,
              direction: req.direction,
            };
          }
        }

        api.addPanel(addOptions);
      }

      // Pin requested sizes after all panels exist. `initialWidth` on
      // addPanel only applies to the panel being added, and dockview falls
      // back to a 50/50 split when subsequent siblings don't specify a width.
      // Setting the size in a second pass — once the container is fully
      // populated — gives us a reliable initial splitter position.
      for (const req of requests) {
        if (req.size === undefined) continue;
        const panel = api.getPanel(req.id);
        if (!panel) continue;
        // Horizontal splits → width; vertical → height. We only support
        // horizontal-with-size today; revisit when a vertical-with-size
        // layout shows up.
        panel.api.setSize({ width: req.size });
      }
    },
    [layout, registry],
  );

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;

      // Publish the api so panels (and any descendants of LayoutManager)
      // can drive the layout imperatively via `useLayoutApi()` — toggle
      // panel visibility, resize, subscribe to layout events.
      setLayoutApi(api);

      // 1. Try to restore persisted layout, but only if the fingerprint matches —
      //    a mismatch means panels were added/removed, so the saved state would
      //    reference stale dockview instance IDs.
      let restored = false;
      if (storageKey) {
        const fingerprint = layoutFingerprint(layout);
        const fingerprintKey = `${storageKey}:fingerprint`;
        const savedFingerprint = localStorage.getItem(fingerprintKey);
        const saved = localStorage.getItem(storageKey);

        if (saved && savedFingerprint === fingerprint) {
          try {
            api.fromJSON(JSON.parse(saved));
            restored = true;
          } catch {
            // Fall through to default layout
          }
        }

        if (!restored) {
          localStorage.removeItem(storageKey);
          localStorage.setItem(fingerprintKey, fingerprint);
        }
      }

      // 2. Build the default layout if nothing was restored.
      if (!restored) buildLayout(api);

      // 3. Subscribe to layout changes for persistence. Attaching the listener
      //    HERE (not in a useEffect) is critical — `apiRef.current` is null on
      //    the first effect run and the deps don't include it, so the listener
      //    never gets attached if subscribed via useEffect. (Old bug.)
      if (storageKey) {
        const fingerprint = layoutFingerprint(layout);
        const fingerprintKey = `${storageKey}:fingerprint`;
        api.onDidLayoutChange(() => {
          try {
            localStorage.setItem(storageKey, JSON.stringify(api.toJSON()));
            localStorage.setItem(fingerprintKey, fingerprint);
          } catch {
            // Persistence is best-effort.
          }
        });
      }
    },
    [buildLayout, layout, storageKey, setLayoutApi],
  );

  // Clear the published api on unmount so consumers don't hold a stale
  // reference. Re-keying on layout change re-runs `onReady` and re-sets
  // the api, but a full unmount (route change with no layout) needs an
  // explicit clear.
  useEffect(() => {
    return () => setLayoutApi(null);
  }, [setLayoutApi]);

  // Re-key on layout/storageKey change so the entire dockview instance
  // remounts. Cheaper than reconciling panel diffs imperatively, and
  // correct: `onReady` fires fresh on every remount.
  const dockKey = useLayoutKey(layout, storageKey);

  const dockview = (
    <DockviewReact
      key={dockKey}
      components={components}
      onReady={handleReady}
      // Anima is a light-themed app; the dock chrome (tabs, splitters, group
      // backgrounds) inherits this. Switch to dockview-theme-dark when we go
      // IDE-style.
      className="dockview-theme-light"
    />
  );

  return (
    <PanelRegistryContext.Provider value={registry}>
      <div className={className} style={{ width: "100%", height: "100%" }}>
        {Provider ? <Provider>{dockview}</Provider> : dockview}
      </div>
    </PanelRegistryContext.Provider>
  );
}
