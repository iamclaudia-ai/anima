/**
 * Claudia iMessage Extension
 *
 * Bridges iMessage to Claudia via the `imsg` CLI tool.
 * Uses JSON-RPC over stdio to watch for new messages and send replies.
 *
 * Features:
 * - Watches for incoming messages using `imsg rpc`
 * - Filters by allowed senders (for safety!)
 * - Routes responses back via source routing
 * - Sends replies using the same chat_id
 */

import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";
import { ImsgRpcClient, type ImsgMessage, type ImsgAttachment } from "./imsg-client";
import { z } from "zod";

// ============================================================================
// Content Block Types (Claude API format)
// ============================================================================

interface TextContentBlock {
  type: "text";
  text: string;
}

interface ImageContentBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

interface DocumentContentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

type ContentBlock = TextContentBlock | ImageContentBlock | DocumentContentBlock;

// ============================================================================
// Configuration
// ============================================================================

export interface IMessageConfig {
  /** Path to imsg CLI (default: "imsg") */
  cliPath?: string;
  /** Path to Messages database */
  dbPath?: string;
  /** Allowed sender addresses - ONLY process messages from these senders */
  allowedSenders?: string[];
  /** Include attachments in messages */
  includeAttachments?: boolean;
  /** Include recent history as context (number of messages, 0 = disabled) */
  historyLimit?: number;
  /** Workspace CWD for session management (default: process.cwd()) */
  workspaceCwd?: string;
}

const DEFAULT_CONFIG: IMessageConfig = {
  cliPath: "imsg",
  dbPath: undefined, // Uses default ~/Library/Messages/chat.db
  allowedSenders: [], // Empty = process no messages (safe default!)
  includeAttachments: false,
  historyLimit: 0,
};

// ============================================================================
// iMessage Extension
// ============================================================================

function isLikelyPhoneNumber(value: string): boolean {
  if (!value) return false;
  if (value.includes("@")) return false;
  if (!/^[+\d().\s-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0;
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/^\+1/, "").replace(/\D/g, "");
}

export function isAllowedSender(sender: string, allowedSenders?: string[]): boolean {
  if (!allowedSenders?.length) {
    return false; // No allowed senders = deny all (safe default)
  }
  if (!sender) return false;
  return allowedSenders.some((allowed) => {
    if (!allowed) return false;
    // Exact match
    if (sender === allowed) return true;
    // Normalize phone numbers (strip +1, etc.) only when both are phone numbers.
    if (isLikelyPhoneNumber(sender) && isLikelyPhoneNumber(allowed)) {
      const normalizedSender = normalizePhoneNumber(sender);
      const normalizedAllowed = normalizePhoneNumber(allowed);
      return normalizedSender !== "" && normalizedSender === normalizedAllowed;
    }
    return false;
  });
}

export function createIMessageExtension(config: IMessageConfig = {}): AnimaExtension {
  const cfg: IMessageConfig = { ...DEFAULT_CONFIG, ...config };

  let client: ImsgRpcClient | null = null;
  let ctx: ExtensionContext | null = null;
  let lastRowId: number | null = null;
  let currentSessionId: string | null = null;

  /**
   * Convert an attachment to a content block
   * Reads the file from disk and converts to base64
   */
  async function attachmentToContentBlock(
    attachment: ImsgAttachment,
  ): Promise<ContentBlock | null> {
    // Skip missing attachments
    if (attachment.missing) {
      ctx?.log.warn(`Attachment missing: ${attachment.filename}`);
      return null;
    }

    // Resolve the path (handle ~ expansion)
    let filePath = attachment.original_path;
    if (filePath.startsWith("~")) {
      filePath = filePath.replace("~", process.env.HOME || "");
    }

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) {
        ctx?.log.warn(`Attachment file not found: ${filePath}`);
        return null;
      }

      const bytes = await file.arrayBuffer();
      const base64 = Buffer.from(bytes).toString("base64");
      const mimeType = attachment.mime_type || "application/octet-stream";

      ctx?.log.info(
        `Read attachment: ${attachment.filename} (${mimeType}, ${bytes.byteLength} bytes)`,
      );

      // Images - send as visual content
      if (mimeType.startsWith("image/")) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: mimeType,
            data: base64,
          },
        };
      }

      // PDFs and text documents - send as document content
      if (mimeType === "application/pdf" || mimeType.startsWith("text/")) {
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: mimeType,
            data: base64,
          },
        };
      }

      // Audio files - return as text instruction to transcribe
      // Common voice memo formats: m4a (iPhone), caf, mp3, wav, aac
      if (
        mimeType.startsWith("audio/") ||
        /\.(m4a|caf|mp3|wav|aac|ogg|flac)$/i.test(attachment.filename)
      ) {
        ctx?.log.info(`Audio attachment detected: ${filePath}`);
        return {
          type: "text",
          text: `[Voice message: ${filePath}] - Please transcribe this audio and respond to what was said.`,
        };
      }

      // Other file types - skip
      ctx?.log.info(`Skipping unsupported attachment type: ${mimeType}`);
      return null;
    } catch (err) {
      ctx?.log.error(`Failed to read attachment ${filePath}: ${err}`);
      return null;
    }
  }

  /**
   * Build content blocks from a message (text + attachments)
   */
  async function buildContentBlocks(message: ImsgMessage): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];

    // Add attachments first (images before text is better for Claude)
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        const block = await attachmentToContentBlock(attachment);
        if (block) {
          blocks.push(block);
        }
      }
    }

    // Add text if present
    if (message.text?.trim()) {
      blocks.push({
        type: "text",
        text: message.text,
      });
    }

    return blocks;
  }

  /**
   * Check if a sender is allowed
   */
  function isAllowedSenderForConfig(sender: string): boolean {
    return isAllowedSender(sender, cfg.allowedSenders);
  }

  /**
   * Build the source identifier for routing
   * Format: imessage/{chat_id}
   */
  function buildSource(chatId: number): string {
    return `imessage/${chatId}`;
  }

  /**
   * Ensure we have a live session, creating one if needed.
   */
  async function ensureSession(cwd: string): Promise<void> {
    await ctx!.call("session.get_or_create_workspace", { cwd });
    const created = (await ctx!.call("session.create_session", { cwd })) as {
      sessionId: string;
    };
    currentSessionId = created.sessionId;
    ctx?.log.info(`Created new iMessage session: ${currentSessionId}`);
  }

  /**
   * Handle an incoming message
   */
  async function handleMessage(message: ImsgMessage): Promise<void> {
    ctx?.log.info(`Received message from ${message.sender} in chat ${message.chat_id}`);

    // Filter: only process messages from allowed senders
    if (!isAllowedSenderForConfig(message.sender)) {
      ctx?.log.info(`Ignoring message from ${message.sender} (not in allowed list)`);
      return;
    }

    // Filter: skip our own messages
    if (message.is_from_me) {
      ctx?.log.info("Ignoring message from self");
      return;
    }

    // Check if message has content (text or attachments)
    const hasText = !!message.text?.trim();
    const hasAttachments = !!message.attachments?.length;

    if (!hasText && !hasAttachments) {
      ctx?.log.info("Ignoring empty message (no text or attachments)");
      return;
    }

    ctx?.log.info(
      `Processing message: "${message.text?.substring(0, 50) || "(no text)"}"` +
        (hasAttachments ? ` + ${message.attachments!.length} attachment(s)` : ""),
    );

    // Track last rowid for resuming
    lastRowId = message.rowid;

    // Build source for routing
    const source = buildSource(message.chat_id);

    // Build content blocks (handles text + attachments)
    const contentBlocks = await buildContentBlocks(message);

    if (contentBlocks.length === 0) {
      ctx?.log.warn("No valid content blocks to send");
      return;
    }

    // Emit event for observability
    ctx?.emit("imessage.message", {
      source,
      chatId: message.chat_id,
      sender: message.sender,
      text: message.text,
      attachmentCount: message.attachments?.length || 0,
      isGroup: message.is_group,
      participants: message.participants,
    });

    // Build content — string for simple text, blocks array for multimodal
    const content =
      contentBlocks.length === 1 && contentBlocks[0].type === "text"
        ? (contentBlocks[0] as TextContentBlock).text
        : contentBlocks;

    // Send prompt via session extension (non-streaming — await completion)
    try {
      // Ensure we have a valid session (create fresh if missing or stale)
      const cwd = cfg.workspaceCwd || process.cwd();
      if (!currentSessionId) {
        await ensureSession(cwd);
      }

      let result: { text: string; sessionId: string };
      try {
        result = (await ctx!.call("session.send_prompt", {
          sessionId: currentSessionId,
          content,
          streaming: false,
          source,
        })) as { text: string; sessionId: string };
      } catch (promptErr) {
        // Session may have been lost after a restart — create a new one and retry
        const errMsg = String(promptErr);
        if (errMsg.includes("not found") || errMsg.includes("not_found")) {
          ctx?.log.warn(`Session ${currentSessionId} gone, creating new one`);
          currentSessionId = null;
          await ensureSession(cwd);
          result = (await ctx!.call("session.send_prompt", {
            sessionId: currentSessionId,
            content,
            streaming: false,
            source,
          })) as { text: string; sessionId: string };
        } else {
          throw promptErr;
        }
      }

      // Send reply back to iMessage
      const replyText = result.text?.trim();
      if (replyText) {
        ctx?.log.info(
          `Sending reply to chat ${message.chat_id}: "${replyText.substring(0, 50)}..."`,
        );
        await client?.send({ chatId: message.chat_id, text: replyText });
        ctx?.emit("imessage.sent", { chatId: message.chat_id, text: result.text });
      }
    } catch (err) {
      ctx?.log.error(`Failed to process message: ${err}`);
      ctx?.emit("imessage.error", { error: String(err), chatId: message.chat_id });
    }
  }

  return {
    id: "imessage",
    name: "iMessage",
    methods: [
      {
        name: "imessage.send",
        description: "Send a text message through iMessage by chatId or recipient handle",
        inputSchema: z
          .object({
            text: z.string().min(1),
            chatId: z.number().optional(),
            to: z.string().min(1).optional(),
          })
          .refine((v) => v.chatId !== undefined || v.to !== undefined, {
            message: "Either chatId or to is required",
          }),
      },
      {
        name: "imessage.status",
        description: "Return iMessage extension runtime status",
        inputSchema: z.object({}),
      },
      {
        name: "imessage.chats",
        description: "List recent iMessage chats",
        inputSchema: z.object({
          limit: z.number().int().positive().max(200).optional(),
        }),
      },
      {
        name: "imessage.health_check",
        description: "Return standardized health_check payload for iMessage extension",
        inputSchema: z.object({}),
      },
    ],
    events: ["imessage.message", "imessage.sent", "imessage.error"],
    sourceRoutes: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Starting iMessage extension...");

      // Merge config from context
      if (context.config) {
        Object.assign(cfg, context.config);
      }

      ctx.log.info(
        `Allowed senders: ${cfg.allowedSenders?.join(", ") || "(none - will ignore all messages)"}`,
      );

      // Create and start the imsg client
      client = new ImsgRpcClient({
        cliPath: cfg.cliPath,
        dbPath: cfg.dbPath,
        onMessage: handleMessage,
        onError: (err) => {
          ctx?.log.error(`imsg error: ${err.message}`);
          ctx?.emit("imessage.error", { error: err.message });
        },
        log: ctx.log,
      });

      await client.start();

      // List chats to verify connection
      try {
        const chats = await client.listChats(5);
        ctx.log.info(`Connected! Found ${chats.length} recent chats`);
        for (const chat of chats) {
          ctx.log.info(
            `  [${chat.id}] ${chat.name || chat.identifier} (${chat.participants.join(", ")})`,
          );
        }
      } catch (err) {
        ctx.log.error(`Failed to list chats: ${err}`);
      }

      // Subscribe to watch for new messages
      try {
        const subId = await client.subscribe({
          attachments: cfg.includeAttachments,
        });
        ctx.log.info(`Subscribed to message watch (subscription: ${subId})`);
      } catch (err) {
        ctx.log.error(`Failed to subscribe: ${err}`);
      }

      ctx.log.info("iMessage extension started");
    },

    async stop() {
      ctx?.log.info("Stopping iMessage extension...");
      await client?.stop();
      client = null;
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "imessage.send": {
          if (!client) throw new Error("iMessage client not running");

          const text = params.text as string;
          const chatId = params.chatId as number | undefined;
          const to = params.to as string | undefined;

          if (!text) throw new Error('Missing "text" parameter');
          if (!chatId && !to) throw new Error('Must provide "chatId" or "to"');

          await client.send({ text, chatId, to });
          ctx?.emit("imessage.sent", { text, chatId, to });
          return { ok: true };
        }

        case "imessage.status": {
          return {
            running: !!client,
            allowedSenders: cfg.allowedSenders,
            lastRowId,
          };
        }

        case "imessage.chats": {
          if (!client) throw new Error("iMessage client not running");
          const limit = (params.limit as number) || 20;
          const chats = await client.listChats(limit);
          return { chats };
        }

        case "imessage.health_check": {
          const response: HealthCheckResponse = {
            ok: !!client,
            status: client ? "healthy" : "disconnected",
            label: "iMessage Bridge",
            metrics: [
              { label: "Status", value: client ? "running" : "stopped" },
              { label: "Allowed Senders", value: cfg.allowedSenders?.length ?? 0 },
              { label: "Last Row ID", value: lastRowId ?? "n/a" },
            ],
          };
          return response;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: !!client,
        details: {
          running: !!client,
          allowedSenders: cfg.allowedSenders?.length ?? 0,
          lastRowId,
        },
      };
    },
  };
}

// Default export
export default createIMessageExtension;

// Re-export client types
export type { ImsgMessage, ImsgChat } from "./imsg-client";

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createIMessageExtension);
