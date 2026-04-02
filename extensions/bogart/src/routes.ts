/**
 * Bogart Extension — Route declarations.
 */

import type { Route } from "@anima/ui";
import { BogartPage } from "./pages/BogartPage";

export const bogartRoutes: Route[] = [{ path: "/bogart", component: BogartPage, label: "Bogart" }];
