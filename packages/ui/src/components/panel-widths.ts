/**
 * panel-widths — remember a panel's last-known width across toggles.
 *
 * Dockview's `addPanel({ initialWidth })` is sometimes ignored when adding
 * next to an existing sibling (it falls back to a 50/50 split). And even
 * when it IS honored, we lose any width the user manually dragged to.
 *
 * This tiny helper snapshots `panel.api.width` before close and lets the
 * caller restore it on the next open. Persisted to localStorage so the
 * memory survives reloads.
 *
 * Usage:
 *   // before close
 *   rememberPanelWidth(EDITOR_PANEL_ID, panel.api.width);
 *   panel.api.close();
 *
 *   // on open
 *   const w = getRememberedPanelWidth(EDITOR_PANEL_ID);
 *   layoutApi.addPanel({ ..., initialWidth: w ?? 800 });
 *   if (w) {
 *     // initialWidth is unreliable; pin in a microtask once dockview
 *     // has finished placing the panel.
 *     queueMicrotask(() => layoutApi.getPanel(id)?.api.setSize({ width: w }));
 *   }
 */

const STORAGE_KEY = "anima:panel-widths";

type WidthMap = Record<string, number>;

function readAll(): WidthMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as WidthMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: WidthMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Persistence is best-effort.
  }
}

export function rememberPanelWidth(panelId: string, width: number): void {
  if (!Number.isFinite(width) || width <= 0) return;
  const map = readAll();
  map[panelId] = Math.round(width);
  writeAll(map);
}

export function getRememberedPanelWidth(panelId: string): number | undefined {
  const map = readAll();
  const value = map[panelId];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
