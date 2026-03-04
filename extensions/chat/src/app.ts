/**
 * Chat Extension — shared constants and bridge for page components.
 */

import type { PlatformBridge } from "@claudia/ui";

// Same-origin: SPA is served by the gateway
const locationProtocol =
  typeof globalThis.location !== "undefined" ? globalThis.location.protocol : "http:";
const locationHost =
  typeof globalThis.location !== "undefined" ? globalThis.location.host : "localhost";
export const GATEWAY_URL = `${locationProtocol === "https:" ? "wss:" : "ws:"}//${locationHost}/ws`;

const GLOBAL_DRAFT_KEY = "claudia-draft";

export function getDraftStorageKey(options?: { workspaceId?: string; sessionId?: string }): string {
  if (options?.workspaceId && options.sessionId) {
    return `claudia:draft:${options.workspaceId}:${options.sessionId}`;
  }
  if (options?.sessionId) {
    return `claudia:draft:${options.sessionId}`;
  }
  return GLOBAL_DRAFT_KEY;
}

export function createBridge(options?: {
  workspaceId?: string;
  sessionId?: string;
}): PlatformBridge {
  const draftKey = getDraftStorageKey(options);
  return {
    platform: "web",
    gatewayUrl: GATEWAY_URL,
    showContextBar: false,
    includeFileContext: false,
    saveDraft: (text) => localStorage.setItem(draftKey, text),
    loadDraft: () => localStorage.getItem(draftKey) || "",
    copyToClipboard: (text) => navigator.clipboard.writeText(text),
  };
}

export const bridge = createBridge();
