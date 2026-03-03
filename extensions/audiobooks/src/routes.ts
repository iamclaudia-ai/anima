/**
 * Audiobooks Extension — route declarations
 */

import type { Route } from "@claudia/ui";
import { Library } from "./pages/Library";
import { BookDetail } from "./pages/BookDetail";
import { ChapterPlayer } from "./pages/ChapterPlayer";

export const audiobooksRoutes: Route[] = [
  { path: "/audiobooks", component: Library, label: "Audiobooks", icon: "🎧" },
  { path: "/audiobooks/:bookId", component: BookDetail, label: "Book" },
  { path: "/audiobooks/:bookId/chapter/:chapterNum", component: ChapterPlayer, label: "Chapter" },
  // Static file serving (handled by gateway, not React router)
  { path: "/audiobooks/static/:path*", static: "~/romance-novels" },
];
