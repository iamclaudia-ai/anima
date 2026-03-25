/**
 * Chat Extension — Server-Side
 *
 * Provides web chat pages (workspaces, sessions, chat UI).
 * No server-side methods needed — session extension handles all runtime concerns.
 */

import type { AnimaExtension, ExtensionContext } from "@anima/shared";

export function createChatExtension(): AnimaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "chat",
    name: "Chat",
    methods: [],
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Chat extension started");
    },

    async stop() {
      ctx?.log.info("Chat extension stopped");
      ctx = null;
    },

    async handleMethod(method: string) {
      throw new Error(`Unknown method: ${method}`);
    },

    health() {
      return { ok: true };
    },
  };
}

export default createChatExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createChatExtension);
