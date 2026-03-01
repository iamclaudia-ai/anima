/**
 * Chat Extension — route declarations.
 *
 * New unified layout with navigation drawer (Slack-style):
 * - MainPage handles both root and session routes
 * - Receives workspaceId/sessionId as props from route params
 * - Shows drawer always, activates workspace/session based on URL
 */

import type { Route } from "@claudia/ui";
import { MainPage } from "./pages/MainPage";

export const chatRoutes: Route[] = [
  { path: "/", component: MainPage, label: "Claudia" },
  { path: "/workspace/:workspaceId/session/:sessionId", component: MainPage, label: "Chat" },
];
