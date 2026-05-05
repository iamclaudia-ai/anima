/**
 * Memory Extension — Route declarations.
 *
 * Pages:
 *   /memory            — Calendar heatmap view
 *   /memory/day/:date  — Day timeline with conversation cards
 *   /memory/episode/:id — Episode detail with narrative + transcript
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
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
  routes: memoryRoutes,
} satisfies ExtensionWebContribution;
