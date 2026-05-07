/**
 * Control Extension — Route declarations.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { Activity } from "lucide-react";
import { MissionControlPage } from "./pages/MissionControlPage";
import { LogViewerPage } from "./pages/LogViewerPage";

export const controlRoutes: Route[] = [
  { path: "/control", component: MissionControlPage, label: "Control" },
  { path: "/logs", component: LogViewerPage, label: "Logs" },
];

export default {
  id: "control",
  name: "Control",
  order: 10,
  icon: Activity,
  color: {
    iconBg: "bg-amber-100",
    iconColor: "text-amber-600",
    ring: "ring-amber-200/70",
    hoverText: "group-hover:text-amber-700",
  },
  routes: controlRoutes,
} satisfies ExtensionWebContribution;
