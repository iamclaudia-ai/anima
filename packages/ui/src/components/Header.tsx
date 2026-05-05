import { Volume2, VolumeX, ChevronLeft, Menu } from "lucide-react";
import { useBridge } from "../bridge";
import type { WorkspaceInfo, SessionInfo } from "../hooks/useChatGateway";

interface HeaderProps {
  isConnected: boolean;
  sessionId: string | null;
  workspace: WorkspaceInfo | null;
  sessions: SessionInfo[];
  onCreateSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  /** Send a raw gateway request */
  sendRequest: (method: string, params?: Record<string, unknown>) => void;
  /** Optional back navigation (web client uses this to go to session list) */
  onBack?: () => void;
  /** Whether voice (TTS) is enabled for this session */
  voiceEnabled?: boolean;
  /** Toggle voice on/off */
  onToggleVoice?: () => void;
  /** Open the navigation drawer (mobile hamburger). When provided, renders a menu button on the left. */
  onOpenMenu?: () => void;
}

export function Header({
  isConnected,
  sessionId,
  workspace,
  sessions,
  onCreateSession,
  onSwitchSession,
  sendRequest,
  onBack,
  voiceEnabled,
  onToggleVoice,
  onOpenMenu,
}: HeaderProps) {
  const bridge = useBridge();

  return (
    <header className="p-4 border-b border-gray-200">
      <div className="flex items-center justify-between">
        {/* Left side: Back button + Workspace info */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {onOpenMenu && (
            <button
              onClick={onOpenMenu}
              className="text-gray-500 hover:text-gray-800 transition-colors flex-shrink-0"
              title="Open navigation"
              aria-label="Open navigation"
            >
              <Menu className="w-6 h-6" />
            </button>
          )}
          {onBack && (
            <button
              onClick={onBack}
              className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
              title="Back to sessions"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-900 truncate">
              {workspace?.name || "..."}
            </h1>
            <p className="text-xs text-gray-500 truncate">
              {workspace?.cwdDisplay || workspace?.cwd || ""}
            </p>
          </div>
        </div>

        {/* Right side: Terminal, Voice, and Connection indicator */}
        <div className="flex items-center gap-2 flex-shrink-0 pr-1">
          {bridge.openTerminal && (
            <button
              onClick={() => bridge.openTerminal!()}
              className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
              title="Split terminal below"
            >
              Terminal
            </button>
          )}

          {/* Voice toggle button */}
          {onToggleVoice && (
            <button
              onClick={onToggleVoice}
              className={`p-1.5 rounded-md transition-colors ${
                voiceEnabled
                  ? "bg-purple-100 text-purple-700 hover:bg-purple-200"
                  : "bg-gray-100 text-gray-400 hover:bg-gray-200"
              }`}
              title={
                voiceEnabled ? "Voice enabled — click to mute" : "Voice muted — click to enable"
              }
            >
              {voiceEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
            </button>
          )}

          {/* Connection indicator */}
          <div
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              isConnected ? "bg-green-500" : "bg-red-500"
            }`}
            title={isConnected ? "Connected" : "Disconnected"}
          />
        </div>
      </div>
    </header>
  );
}
