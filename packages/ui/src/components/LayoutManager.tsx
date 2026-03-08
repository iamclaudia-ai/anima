/**
 * LayoutManager — Renders panel layouts using dockview.
 *
 * Extensions register panels by string ID. Layouts reference those IDs.
 * The LayoutManager resolves IDs → components at runtime via a panel registry.
 * Unresolved panels render a graceful error placeholder.
 *
 * Persistence: dockview's toJSON()/fromJSON() handles layout save/restore.
 * The LayoutManager auto-persists to localStorage keyed by layout name.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ComponentType } from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type DockviewApi,
} from "dockview-react";
import "dockview/dist/styles/dockview.css";
import type { LayoutNode } from "@claudia/shared";

// ── Panel Registry ──────────────────────────────────────────

export interface PanelRegistration {
  /** Unique panel ID (e.g., "chat.main") */
  id: string;
  /** Display title */
  title: string;
  /** Icon name or emoji */
  icon?: string;
  /** React component to render in this panel */
  // biome-ignore lint: Panel components have varying prop signatures
  component: ComponentType<any>;
}

export type PanelRegistry = Map<string, PanelRegistration>;

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

/**
 * Wraps a registered panel component for dockview.
 * Receives the panel registry via params and resolves the component at render time.
 */
function PanelWrapper(props: IDockviewPanelProps<{ panelId: string; registry: PanelRegistry }>) {
  const { panelId, registry } = props.params;
  const registration = registry.get(panelId);

  if (!registration) {
    return <PanelNotFound panelId={panelId} />;
  }

  const Component = registration.component;
  return <Component />;
}

// ── Layout Builder ──────────────────────────────────────────

interface PanelAddRequest {
  id: string;
  panelId: string;
  title: string;
  direction?: "right" | "below";
  referencePanel?: string;
  size?: number;
  renderer?: "always" | "onlyWhenVisible";
}

/**
 * Walks a LayoutNode tree and produces a flat list of panel add requests
 * with positioning info that dockview can consume sequentially.
 */
function flattenLayout(node: LayoutNode, parentRef?: string): PanelAddRequest[] {
  const requests: PanelAddRequest[] = [];

  if ("panel" in node) {
    // Leaf node
    requests.push({
      id: node.panel,
      panelId: node.panel,
      title: node.panel,
      referencePanel: parentRef,
      direction: parentRef ? "right" : undefined,
      size: node.size,
    });
  } else {
    // Split node
    const directionMap = {
      horizontal: "right" as const,
      vertical: "below" as const,
    };

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childRequests = flattenLayout(
        child,
        i > 0 ? getFirstPanelId(node.children[i - 1]) : parentRef,
      );

      // For the first child in a split, use parent's reference
      // For subsequent children, position relative to the previous sibling
      if (i > 0 && childRequests.length > 0) {
        childRequests[0].direction = directionMap[node.direction];
      }

      requests.push(...childRequests);
    }
  }

  return requests;
}

/** Get the first panel ID from a layout node (for reference positioning) */
function getFirstPanelId(node: LayoutNode): string {
  if ("panel" in node) return node.panel;
  if (node.children.length > 0) return getFirstPanelId(node.children[0]);
  return "";
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
}

// ── Component ───────────────────────────────────────────────

export function LayoutManager({ registry, layout, storageKey, className }: LayoutManagerProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const registryRef = useRef(registry);
  registryRef.current = registry;

  // Dockview components map — single wrapper that resolves via registry
  const components = useMemo(
    () => ({
      "panel-wrapper": PanelWrapper,
    }),
    [],
  );

  const buildLayout = useCallback(
    (api: DockviewApi) => {
      const requests = flattenLayout(layout);

      for (const req of requests) {
        const registration = registry.get(req.panelId);
        const title = registration?.title ?? req.panelId;

        // Use 'always' renderer for panels that might contain iframes
        const renderer = req.panelId.startsWith("editor.") ? ("always" as const) : undefined;

        const addOptions: Parameters<typeof api.addPanel>[0] = {
          id: req.id,
          component: "panel-wrapper",
          title,
          params: { panelId: req.panelId, registry: registryRef.current },
          renderer,
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
    },
    [layout, registry],
  );

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Try to restore persisted layout
      if (storageKey) {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            event.api.fromJSON(parsed);
            return;
          } catch {
            // Fall through to default layout
            localStorage.removeItem(storageKey);
          }
        }
      }

      // Build from default layout definition
      buildLayout(event.api);
    },
    [buildLayout, storageKey],
  );

  // Auto-persist on layout changes
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !storageKey) return;

    const disposable = api.onDidLayoutChange(() => {
      try {
        const state = api.toJSON();
        localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        // Silently fail — persistence is best-effort
      }
    });

    return () => disposable.dispose();
  }, [storageKey]);

  return (
    <div className={className} style={{ width: "100%", height: "100%" }}>
      <DockviewReact
        components={components}
        onReady={handleReady}
        className="dockview-theme-dark"
      />
    </div>
  );
}
