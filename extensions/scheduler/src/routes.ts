/**
 * Scheduler Extension — Route declarations.
 */

import type { Route } from "@anima/ui";
import { SchedulerPage } from "./pages/SchedulerPage";

export const schedulerRoutes: Route[] = [
  { path: "/scheduler", component: SchedulerPage, label: "Scheduler", title: "Scheduler" },
];
