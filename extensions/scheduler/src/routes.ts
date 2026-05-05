/**
 * Scheduler Extension — Route declarations.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { SchedulerPage } from "./pages/SchedulerPage";

export const schedulerRoutes: Route[] = [
  { path: "/scheduler", component: SchedulerPage, label: "Scheduler", title: "Scheduler" },
];

export default {
  id: "scheduler",
  name: "Scheduler",
  order: 60,
  routes: schedulerRoutes,
} satisfies ExtensionWebContribution;
