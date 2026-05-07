// Main component
export { ClaudiaChat } from "./components/ClaudiaChat";

// Bogart sprite URLs — exposed so the scratchpad page can reuse the same
// hashed-asset URLs Bun emits when bundling @anima/ui (no duplicate sprites).
export { BOGART_SPRITE_URLS } from "./components/Bogart";

// Bridge
export { BridgeContext, useBridge } from "./bridge";
export type { PlatformBridge } from "./bridge";

// Contexts
export { WorkspaceProvider, useWorkspace } from "./contexts/WorkspaceContext";
export { GatewayClientProvider, useGatewayClientContext } from "./contexts/GatewayClientContext";
export type { GatewayClientProviderProps } from "./contexts/GatewayClientContext";
export { ExtensionConfigProvider, useExtensionConfig } from "./contexts/ExtensionConfigContext";
export type {
  ExtensionConfigMap,
  ExtensionConfigProviderProps,
  ExtensionWebConfig,
} from "./contexts/ExtensionConfigContext";
export { HeaderSlotsProvider, useHeaderSlot, useHeaderSlots } from "./contexts/HeaderSlotsContext";
export type {
  HeaderSegment,
  HeaderSlot,
  HeaderSlotsProviderProps,
  UseHeaderSlotOptions,
} from "./contexts/HeaderSlotsContext";
export { LayoutApiProvider, useLayoutApi } from "./contexts/LayoutApiContext";
export type { LayoutApiProviderProps } from "./contexts/LayoutApiContext";

// Types
export type {
  Message,
  ContentBlock,
  TextBlock,
  ImageBlock,
  FileBlock,
  ToolUseBlock,
  ErrorBlock,
  Usage,
  Attachment,
  GatewayMessage,
  EditorContext,
} from "./types";

// Router
export { Router, Link, useRouter, navigate, matchPath, useDocumentTitle } from "./router";
export type { ExtensionWebContribution, LauncherColor, PanelContribution, Route } from "./router";

// Hooks
export { useChatGateway } from "./hooks/useChatGateway";
export { useGatewayClient } from "./hooks/useGatewayClient";
export { useIsMobile } from "./hooks/useIsMobile";
export { useVoiceEnabled } from "./hooks/useVoiceEnabled";
export type {
  UseChatGatewayOptions,
  UseChatGatewayReturn,
  WorkspaceInfo,
  SessionInfo,
  SubagentInfo,
  GitStatusInfo,
} from "./hooks/useChatGateway";
export type { UseGatewayClientOptions, UseGatewayClientReturn } from "./hooks/useGatewayClient";

// Components (for direct use if needed)
export { Header } from "./components/Header";
export { AppHeader } from "./components/AppHeader";
export { ContextBar } from "./components/ContextBar";
export { MessageList } from "./components/MessageList";
export { MessageContent } from "./components/MessageContent";
export { ToolCallBlock } from "./components/ToolCallBlock";
export { InputArea } from "./components/InputArea";
export { CopyButton } from "./components/CopyButton";
export { ClaudiaThinking } from "./components/ClaudiaThinking";
export { SubagentActivityStrip } from "./components/SubagentActivityStrip";
export { GitStatusBar } from "./components/GitStatusBar";
export { LayoutManager } from "./components/LayoutManager";
export type { PanelRegistration, PanelRegistry } from "./components/LayoutManager";
export { rememberPanelWidth, getRememberedPanelWidth } from "./components/panel-widths";
export { ErrorBoundary } from "./components/ErrorBoundary";
export { GlobalNotifications } from "./components/GlobalNotifications";
export { LoginGate, logout } from "./components/LoginGate";
export { NavigationDrawer } from "./components/NavigationDrawer";
export type { WorkspaceMenuAction, SettingsMenuAction } from "./components/NavigationDrawer";
export { CreateWorkspaceModal } from "./components/CreateWorkspaceModal";
