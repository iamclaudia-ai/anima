/**
 * Control Extension — Route declarations.
 */

import type { Route } from "@anima/ui";
import { MissionControlPage } from "./pages/MissionControlPage";
import { LogViewerPage } from "./pages/LogViewerPage";

export const controlRoutes: Route[] = [
  { path: "/control", component: MissionControlPage, label: "Control" },
  { path: "/logs", component: LogViewerPage, label: "Logs" },
];
