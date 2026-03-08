// Main component
export { ClaudiaChat } from "./components/ClaudiaChat";

// Bridge
export { BridgeContext, useBridge } from "./bridge";
export type { PlatformBridge } from "./bridge";

// Contexts
export { WorkspaceProvider, useWorkspace } from "./contexts/WorkspaceContext";
export { GatewayClientProvider, useGatewayClientContext } from "./contexts/GatewayClientContext";
export type { GatewayClientProviderProps } from "./contexts/GatewayClientContext";

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
export { Router, Link, useRouter, navigate, matchPath } from "./router";
export type { Route } from "./router";

// Hooks
export { useChatGateway } from "./hooks/useChatGateway";
export { useGatewayClient } from "./hooks/useGatewayClient";
export type {
  UseChatGatewayOptions,
  UseChatGatewayReturn,
  WorkspaceInfo,
  SessionInfo,
  TaskInfo,
} from "./hooks/useChatGateway";
export type { UseGatewayClientOptions, UseGatewayClientReturn } from "./hooks/useGatewayClient";

// Components (for direct use if needed)
export { Header } from "./components/Header";
export { ContextBar } from "./components/ContextBar";
export { MessageList } from "./components/MessageList";
export { MessageContent } from "./components/MessageContent";
export { ToolCallBlock } from "./components/ToolCallBlock";
export { InputArea } from "./components/InputArea";
export { CopyButton } from "./components/CopyButton";
export { ClaudiaThinking } from "./components/ClaudiaThinking";
export { TaskActivityStrip } from "./components/TaskActivityStrip";
export { ErrorBoundary } from "./components/ErrorBoundary";
export { NavigationDrawer } from "./components/NavigationDrawer";
export { CreateWorkspaceModal } from "./components/CreateWorkspaceModal";
