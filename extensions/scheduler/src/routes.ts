/**
 * Scheduler Extension — Route declarations.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { CalendarClock } from "lucide-react";
import { SchedulerPage } from "./pages/SchedulerPage";

export const schedulerRoutes: Route[] = [
  { path: "/scheduler", component: SchedulerPage, label: "Scheduler", title: "Scheduler" },
];

export default {
  id: "scheduler",
  name: "Scheduler",
  order: 60,
  icon: CalendarClock,
  color: {
    iconBg: "bg-sky-100",
    iconColor: "text-sky-600",
    ring: "ring-sky-200/70",
    hoverText: "group-hover:text-sky-700",
  },
  routes: schedulerRoutes,
} satisfies ExtensionWebContribution;
