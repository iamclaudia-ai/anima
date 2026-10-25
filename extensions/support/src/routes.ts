/**
 * Support Extension — Route declarations.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { LifeBuoy } from "lucide-react";
import { SupportPage } from "./pages/SupportPage";

export const supportRoutes: Route[] = [
  { path: "/support", component: SupportPage, label: "Support", title: "Support" },
  { path: "/support/:ticketId", component: SupportPage, label: "Ticket", title: "Support" },
];

export default {
  id: "support",
  name: "Support",
  order: 55,
  icon: LifeBuoy,
  color: {
    iconBg: "bg-rose-100",
    iconColor: "text-rose-600",
    ring: "ring-rose-200/70",
    hoverText: "group-hover:text-rose-700",
  },
  routes: supportRoutes,
} satisfies ExtensionWebContribution;
