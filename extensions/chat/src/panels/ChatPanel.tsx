/**
 * ChatPanel — The conversation view.
 *
 * Reads active workspace/session from `useChatPage()`. Empty state when no
 * session is selected (so the user sees a "create one" prompt instead of a
 * blank panel).
 */

import { ClaudiaChat } from "@anima/ui";
import { useChatPage } from "../context/ChatPageContext";

export function ChatPanel() {
  const { activeWorkspace, activeSessionId, chatBridge, onNewSession } = useChatPage();

  // Dockview's content container has its own (dark) background — paint over
  // it with white at the panel root so we don't inherit theme colors.
  if (!activeSessionId || !activeWorkspace) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-white">
        <p className="text-gray-400">
          {activeWorkspace
            ? "No sessions yet for this workspace"
            : "Select a workspace to get started"}
        </p>
        {activeWorkspace && (
          <button
            type="button"
            onClick={onNewSession}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            Create new session
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-white">
      <ClaudiaChat
        bridge={chatBridge}
        gatewayOptions={{ sessionId: activeSessionId, workspaceId: activeWorkspace.id }}
        // Re-mount when workspace/session changes — keeps streaming state clean.
        key={`${activeWorkspace.id}-${activeSessionId}`}
      />
    </div>
  );
}
