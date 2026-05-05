/**
 * Control Extension — Route declarations.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
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
  routes: controlRoutes,
} satisfies ExtensionWebContribution;
