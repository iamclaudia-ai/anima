/**
 * Audiobooks Extension — route declarations
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { Library } from "./pages/Library";
import { BookDetail } from "./pages/BookDetail";
import { ChapterPlayer } from "./pages/ChapterPlayer";

export const audiobooksRoutes: Route[] = [
  { path: "/audiobooks", component: Library, label: "Audiobooks", icon: "🎧" },
  { path: "/audiobooks/:bookId", component: BookDetail, label: "Book" },
  { path: "/audiobooks/:bookId/chapter/:chapterNum", component: ChapterPlayer, label: "Chapter" },
  // Note: /audiobooks/static/* is served by the gateway via this extension's
  // webStatic declaration in src/index.ts — not a React route.
];

export default {
  id: "audiobooks",
  name: "Audiobooks",
  order: 50,
  routes: audiobooksRoutes,
} satisfies ExtensionWebContribution;
