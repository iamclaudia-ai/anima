/**
 * Audiobooks Extension — route declarations
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { Headphones } from "lucide-react";
import { Library } from "./pages/Library";
import { BookDetail } from "./pages/BookDetail";
import { ChapterPlayer } from "./pages/ChapterPlayer";

export const audiobooksRoutes: Route[] = [
  { path: "/audiobooks", component: Library, label: "Audiobooks" },
  { path: "/audiobooks/:bookId", component: BookDetail, label: "Book" },
  { path: "/audiobooks/:bookId/chapter/:chapterNum", component: ChapterPlayer, label: "Chapter" },
  // Note: /audiobooks/static/* is served by the gateway via this extension's
  // webStatic declaration in src/index.ts — not a React route.
];

export default {
  id: "audiobooks",
  name: "Audiobooks",
  order: 50,
  icon: Headphones,
  color: {
    iconBg: "bg-emerald-100",
    iconColor: "text-emerald-600",
    ring: "ring-emerald-200/70",
    hoverText: "group-hover:text-emerald-700",
  },
  routes: audiobooksRoutes,
} satisfies ExtensionWebContribution;
