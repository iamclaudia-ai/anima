/**
 * Presenter Extension — Route declarations.
 */

import type { Route } from "@claudia/ui";
import { PresenterPage } from "./pages/PresenterPage";
import { PresentationsListPage } from "./pages/PresentationsListPage";

export const presenterRoutes: Route[] = [
  { path: "/present", component: PresentationsListPage, label: "Presentations" },
  { path: "/present/:id", component: PresenterPage, label: "Present" },
];
