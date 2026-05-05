/**
 * Layout flattening — converts a `LayoutNode` tree into a sequential list of
 * `PanelAddRequest`s that dockview can consume one at a time.
 *
 * Dockview's API is imperative: you call `addPanel({ position: { referencePanel,
 * direction } })` for each panel, and each new panel splits relative to a
 * previously-added one. To translate our declarative tree into that sequence
 * we walk depth-first and:
 *
 *   - The first panel of each split inherits its parent split's reference and
 *     direction (so it sits relative to whatever's outside the split).
 *   - Subsequent siblings reference the previous sibling's first leaf, with
 *     the split's own direction.
 *
 * Extracted into its own module (separate from LayoutManager) so the logic can
 * be unit-tested without pulling in the whole dockview React component tree.
 */

import type { LayoutNode } from "@anima/shared";

/** Dockview-bound direction (the API uses these literal strings). */
export type DockDirection = "right" | "below";

export interface PanelAddRequest {
  /** Unique dockview instance ID — one per leaf, even if `panelId` repeats. */
  id: string;
  /** Registry key — looked up against the panel registry to resolve the component. */
  panelId: string;
  /** Per-instance params forwarded to the panel component as React props. */
  params?: Record<string, unknown>;
  /** Title used for the dockview tab; resolved at render time from the registry. */
  title: string;
  /** Reference panel (by `id`) for relative positioning. Undefined for the first panel. */
  referencePanel?: string;
  /** Split direction relative to `referencePanel`. Undefined for the first panel. */
  direction?: DockDirection;
  /** Optional initial size in pixels — currently mapped to dockview `initialWidth/Height`. */
  size?: number;
}

const directionMap = {
  horizontal: "right" as const,
  vertical: "below" as const,
};

/**
 * Build a unique dockview ID for a leaf. When the layout doesn't supply
 * `instanceId` we fall back to `${panel}#${index}` so the same panel type
 * can appear multiple times in one layout without colliding.
 */
function leafInstanceId(panel: string, instanceId: string | undefined, index: number): string {
  if (instanceId) return instanceId;
  return index === 0 ? panel : `${panel}#${index}`;
}

/**
 * Flatten a layout tree into the sequence of panel-add operations dockview needs.
 * `parentRef` is the dockview ID of the leaf this subtree should attach to;
 * `parentDirection` is the dockview direction the subtree's first leaf should use.
 */
export function flattenLayout(
  node: LayoutNode,
  parentRef?: string,
  parentDirection?: DockDirection,
  // Mutable counter shared across the whole walk so panel-instance suffixes
  // are unique across the entire tree (not just per-split).
  counters: Map<string, number> = new Map(),
): PanelAddRequest[] {
  if ("panel" in node) {
    const seen = counters.get(node.panel) ?? 0;
    counters.set(node.panel, seen + 1);
    const id = leafInstanceId(node.panel, node.instanceId, seen);
    return [
      {
        id,
        panelId: node.panel,
        params: node.params,
        title: node.panel,
        referencePanel: parentRef,
        direction: parentRef ? parentDirection : undefined,
        size: node.size,
      },
    ];
  }

  const requests: PanelAddRequest[] = [];
  const splitDirection = directionMap[node.direction];

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i] as LayoutNode;
    if (i === 0) {
      // First child anchors to whatever's outside this split, with the
      // direction inherited from the parent (or none, if we're at the root).
      requests.push(...flattenLayout(child, parentRef, parentDirection, counters));
    } else {
      // Subsequent children attach to the previous sibling's *first* leaf,
      // splitting in this node's own direction.
      const prevAnchor = firstLeafIdOf(requests, node.children[i - 1] as LayoutNode);
      requests.push(...flattenLayout(child, prevAnchor, splitDirection, counters));
    }
  }
  return requests;
}

/**
 * Find the dockview ID of the first leaf inside a subtree, given the
 * already-emitted request list. We can't recompute it because instance
 * counters are stateful — we have to read what flattenLayout actually
 * emitted for that subtree.
 */
function firstLeafIdOf(emitted: PanelAddRequest[], child: LayoutNode): string | undefined {
  if ("panel" in child) {
    // The most recent emission whose panelId matches and whose instanceId
    // matches what flattenLayout would have generated. Easier: just take the
    // last emission whose panelId matches, walking backward — but that's
    // brittle for repeated panels. Instead, find the last leaf whose panelId
    // equals child.panel; flattenLayout emits leaves in walk order, and the
    // previous sibling's leaves immediately precede the current child.
    for (let i = emitted.length - 1; i >= 0; i--) {
      const req = emitted[i] as PanelAddRequest;
      if (req.panelId === child.panel) return req.id;
    }
    return undefined;
  }
  // Walk into the split — its first leaf is the same as ours.
  if (child.children.length === 0) return undefined;
  return firstLeafIdOf(emitted, child.children[0] as LayoutNode);
}

/**
 * Stable fingerprint for a layout tree — used to invalidate persisted state
 * when an extension changes the layout shape (panels added/removed, direction
 * flipped). Includes `instanceId` so renaming an instance also invalidates.
 */
export function layoutFingerprint(node: LayoutNode): string {
  if ("panel" in node) {
    return node.instanceId ? `${node.panel}#${node.instanceId}` : node.panel;
  }
  return `${node.direction}[${node.children.map(layoutFingerprint).join(",")}]`;
}
