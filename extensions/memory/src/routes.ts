/**
 * Memory Extension — Route declarations.
 *
 * Pages:
 *   /memory            — Calendar heatmap view
 *   /memory/day/:date  — Day timeline with conversation cards
 *   /memory/episode/:id — Episode detail with narrative + transcript
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { BookHeart } from "lucide-react";
import { MemoryCalendarPage } from "./pages/MemoryCalendarPage";
import { DayTimelinePage } from "./pages/DayTimelinePage";
import { EpisodeDetailPage } from "./pages/EpisodeDetailPage";

export const memoryRoutes: Route[] = [
  { path: "/memory", component: MemoryCalendarPage, label: "Memory" },
  { path: "/memory/day/:date", component: DayTimelinePage, label: "Day" },
  { path: "/memory/episode/:id", component: EpisodeDetailPage, label: "Episode" },
];

export default {
  id: "memory",
  name: "Memory",
  order: 20,
  icon: BookHeart,
  color: {
    iconBg: "bg-violet-100",
    iconColor: "text-violet-600",
    ring: "ring-violet-200/70",
    hoverText: "group-hover:text-violet-700",
  },
  routes: memoryRoutes,
} satisfies ExtensionWebContribution;
