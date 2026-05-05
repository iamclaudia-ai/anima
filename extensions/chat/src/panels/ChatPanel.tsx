/**
 * ChatPanel — The conversation view.
 *
 * Reads active workspace/session from `useChatPage()`. Empty state when no
 * session is selected (so the user sees a "create one" prompt instead of a
 * blank panel).
 *
 * On mobile, the layout drops the nav panel — so this panel renders a
 * hamburger affordance in ClaudiaChat's Header that slides NavPanel in as
 * an overlay drawer. Auto-closes when the active session changes.
 */

import { useEffect, useState } from "react";
import { ClaudiaChat, useIsMobile } from "@anima/ui";
import { Menu, X } from "lucide-react";
import { useChatPage } from "../context/ChatPageContext";
import { NavPanel } from "./NavPanel";

export function ChatPanel() {
  const { activeWorkspace, activeSessionId, chatBridge, onNewSession } = useChatPage();
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);

  // Auto-close the mobile drawer when the user picks a session, or when
  // we leave mobile (e.g., user rotates / resizes back to desktop).
  useEffect(() => {
    setNavOpen(false);
  }, [activeSessionId, activeWorkspace?.id, isMobile]);

  const onOpenMenu = isMobile ? () => setNavOpen(true) : undefined;

  // Dockview's content container has its own (dark) background — paint over
  // it with white at the panel root so we don't inherit theme colors.
  let body: React.ReactNode;
  if (!activeSessionId || !activeWorkspace) {
    body = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-white">
        {isMobile && (
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="absolute top-3 left-3 rounded-md p-2 text-gray-600 hover:bg-gray-100"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <p className="text-gray-400">
          {activeWorkspace
            ? "No sessions yet for this workspace"
            : "Select a workspace to get started"}
        </p>
        {activeWorkspace && (
          <button
            type="button"
            onClick={() => onNewSession()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            Create new session
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="h-full w-full bg-white">
        <ClaudiaChat
          bridge={chatBridge}
          gatewayOptions={{ sessionId: activeSessionId, workspaceId: activeWorkspace.id }}
          onOpenMenu={onOpenMenu}
          // Re-mount when workspace/session changes — keeps streaming state clean.
          key={`${activeWorkspace.id}-${activeSessionId}`}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {body}
      {isMobile && navOpen && (
        <>
          {/* Backdrop */}
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 bg-black/40"
          />
          {/* Sliding drawer */}
          <div className="fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[320px] bg-white shadow-xl">
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              className="absolute top-2 right-2 z-10 rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
            <NavPanel />
          </div>
        </>
      )}
    </div>
  );
}
