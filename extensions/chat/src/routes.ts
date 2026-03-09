/**
 * Chat Extension — route, panel, and layout declarations.
 *
 * Panels: Components that can be placed in layout panels.
 * Layouts: Named layout configurations referencing panel IDs.
 * Routes: URL patterns mapped to either a layout or a component.
 */

import type { Route } from "@claudia/ui";
import type { PanelDefinition, LayoutDefinition } from "@claudia/shared";
import { MainPage } from "./pages/MainPage";
import { ChatPanel } from "./panels/ChatPanel";

// ── Panels ──────────────────────────────────────────────────

export const chatPanels: (PanelDefinition & { component: React.ComponentType })[] = [
  { id: "chat.main", title: "Chat", icon: "MessageSquare", component: ChatPanel },
];

// ── Layouts ─────────────────────────────────────────────────

export const chatLayouts: Record<string, LayoutDefinition> = {
  ide: {
    default: {
      panel: "chat.main",
    },
    mobile: {
      panel: "chat.main",
    },
  },
};

// ── Routes ──────────────────────────────────────────────────

export const chatRoutes: Route[] = [
  { path: "/", layout: "ide", label: "Claudia" },
  { path: "/workspace/:workspaceId", layout: "ide", label: "Workspace" },
  { path: "/workspace/:workspaceId/session/:sessionId", layout: "ide", label: "Chat" },
];
