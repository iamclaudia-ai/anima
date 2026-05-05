/**
 * Presenter Extension — Route declarations.
 *
 * Dual-screen workflow:
 *   /present/:id/presenter  — Laptop: notes + controls + next slide preview
 *   /present/:id/display    — Projector: clean fullscreen slides (synced)
 *   /present/:id            — Standalone: fullscreen with optional notes (N key)
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { PresenterPage } from "./pages/PresenterPage";
import { PresenterNotesPage } from "./pages/PresenterNotesPage";
import { DisplayPage } from "./pages/DisplayPage";
import { PresentationsListPage } from "./pages/PresentationsListPage";

export const presenterRoutes: Route[] = [
  { path: "/present", component: PresentationsListPage, label: "Presentations" },
  { path: "/present/:id/presenter", component: PresenterNotesPage, label: "Presenter Notes" },
  { path: "/present/:id/display", component: DisplayPage, label: "Display" },
  { path: "/present/:id", component: PresenterPage, label: "Present" },
];

export default {
  id: "presenter",
  name: "Presenter",
  order: 30,
  routes: presenterRoutes,
} satisfies ExtensionWebContribution;
