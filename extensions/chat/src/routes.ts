/**
 * Chat Extension — route declarations.
 *
 * New unified layout with navigation drawer (Slack-style):
 * - MainPage: shows drawer + chat in one view
 * - SessionPage: deep link support for specific sessions
 */

import type { Route } from "@claudia/ui";
import { MainPage } from "./pages/MainPage";
import { SessionPage } from "./pages/SessionPage";

export const chatRoutes: Route[] = [
  { path: "/", component: MainPage, label: "Claudia" },
  { path: "/workspace/:workspaceId/session/:sessionId", component: SessionPage, label: "Chat" },
];
