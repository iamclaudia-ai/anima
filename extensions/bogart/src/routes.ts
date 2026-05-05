/**
 * Bogart Extension — Route declarations.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { BogartPage } from "./pages/BogartPage";

export const bogartRoutes: Route[] = [{ path: "/bogart", component: BogartPage, label: "Bogart" }];

export default {
  id: "bogart",
  name: "Bogart",
  order: 70,
  routes: bogartRoutes,
} satisfies ExtensionWebContribution;
