/**
 * Chat Extension — route, panel, and layout declarations.
 *
 * Panels: Components that can be placed in layout panels.
 * Layouts: Named layout configurations referencing panel IDs.
 * Routes: URL patterns mapped to either a layout or a component.
 *
 * The `ide` layout splits NavigationDrawer and the chat view into two
 * dockview panels. Shared state (workspaces, sessions, active selection,
 * create-workspace modal) is hoisted into `ChatPageProvider`, which the
 * layout installs around the dockview tree via `LayoutDefinition.provider`.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import type { PanelDefinition, LayoutDefinition } from "@anima/shared";
import { MessageSquare } from "lucide-react";
import { NavPanel } from "./panels/NavPanel";
import { ChatPanel } from "./panels/ChatPanel";
import { ChatPageProvider } from "./context/ChatPageContext";

// ── Panels ──────────────────────────────────────────────────

export const chatPanels: (PanelDefinition & { component: React.ComponentType })[] = [
  { id: "chat.nav", title: "Workspaces", icon: "Folder", component: NavPanel },
  { id: "chat.main", title: "Chat", icon: "MessageSquare", component: ChatPanel },
];

// ── Layouts ─────────────────────────────────────────────────

export const chatLayouts: Record<string, LayoutDefinition> = {
  ide: {
    // Desktop: nav on the left, chat fills the rest. Mobile: chat only —
    // the nav is reachable via NavigationDrawer's own hamburger affordance
    // when we wire that up; for now mobile users land directly on chat.
    default: {
      direction: "horizontal",
      children: [{ panel: "chat.nav", size: 300 }, { panel: "chat.main" }],
    },
    mobile: { panel: "chat.main" },
    provider: ChatPageProvider,
  },
};

// ── Routes ──────────────────────────────────────────────────

// The first route is what the home-page launcher tile links to.
export const chatRoutes: Route[] = [
  { path: "/chat", layout: "ide", title: "Chat", label: "Claudia" },
  { path: "/chat/:workspaceId", layout: "ide", title: "Workspace", label: "Workspace" },
  {
    path: "/chat/:workspaceId/:sessionId",
    layout: "ide",
    title: "Chat",
    label: "Chat",
  },
];

export default {
  id: "chat",
  name: "Claudia",
  order: 40,
  icon: MessageSquare,
  color: {
    iconBg: "bg-rose-100",
    iconColor: "text-rose-600",
    ring: "ring-rose-200/70",
    hoverText: "group-hover:text-rose-700",
  },
  routes: chatRoutes,
  panels: chatPanels,
  layouts: chatLayouts,
} satisfies ExtensionWebContribution;
