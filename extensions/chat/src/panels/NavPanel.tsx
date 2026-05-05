/**
 * NavPanel — Workspace + session list, plus the create-workspace modal.
 *
 * All state and handlers come from `useChatPage()`. No props.
 */

import { NavigationDrawer, CreateWorkspaceModal } from "@anima/ui";
import { useChatPage } from "../context/ChatPageContext";

export function NavPanel() {
  const {
    workspaces,
    sessions,
    activeWorkspace,
    activeSessionId,
    isConnected,
    showCreateWorkspaceModal,
    isCreatingWorkspace,
    onWorkspaceSelect,
    onSessionSelect,
    onNewSession,
    onNewWorkspace,
    onCloseCreateWorkspaceModal,
    onCreateWorkspace,
    onGetDirectories,
  } = useChatPage();

  return (
    <>
      <NavigationDrawer
        workspaces={workspaces}
        sessions={sessions}
        activeWorkspace={activeWorkspace}
        activeSessionId={activeSessionId}
        isConnected={isConnected}
        onWorkspaceSelect={onWorkspaceSelect}
        onSessionSelect={onSessionSelect}
        onNewSession={onNewSession}
        onNewWorkspace={onNewWorkspace}
      />
      <CreateWorkspaceModal
        isOpen={showCreateWorkspaceModal}
        onClose={onCloseCreateWorkspaceModal}
        onSubmit={onCreateWorkspace}
        onGetDirectories={onGetDirectories}
        isCreating={isCreatingWorkspace}
      />
    </>
  );
}
