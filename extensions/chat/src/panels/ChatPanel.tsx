/**
 * ChatPanel — Wraps MainPage for use inside the layout system.
 *
 * For now this is a thin wrapper around MainPage that reads route params
 * from the router context. Later we can decompose MainPage into separate
 * panels (nav rail, chat, etc.).
 */

import { useRouter } from "@anima/ui";
import { MainPage } from "../pages/MainPage";

export function ChatPanel() {
  const { params } = useRouter();
  return <MainPage workspaceId={params.workspaceId} sessionId={params.sessionId} />;
}
