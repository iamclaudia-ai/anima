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
import { PERSISTENT_SESSION_ID } from "@anima/shared";
import { ImsgRpcClient, type ImsgMessage, type ImsgAttachment } from "./imsg-client";
import {
  type ChatMemories,
  type ChatMemory,
  OUTSIDE_WINDOW_MS,
  STORE_KEY,
  advanceCursor,
  NO_OUTSIDE,
  type OutsideContext,
  collectOutside,
  formatOutside,
  isEmptyOutside,
  memoryFor,
  rememberReply,
  withOutsideContext,
} from "./outside-messages";
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

interface SessionPromptResult {
  text: string;
  sessionId: string;
}

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
  /** Catch up on missed messages at startup (default: true) */
  catchupEnabled?: boolean;
  /** Max age of missed messages to respond to, in hours (default: 24) */
  catchupWindowHours?: number;
  /** Max unanswered messages to process per chat (default: 20) */
  catchupMaxMessages?: number;
}

const DEFAULT_CONFIG: IMessageConfig = {
  cliPath: "imsg",
  dbPath: undefined, // Uses default ~/Library/Messages/chat.db
  allowedSenders: [], // Empty = process no messages (safe default!)
  includeAttachments: false,
  historyLimit: 0,
};

const reactSchema = z.object({
  kind: z
    .string()
    .min(1)
    .describe("love | like | dislike | laugh | emphasize | question, or a single emoji"),
  chatId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Defaults to the chat of Michael's most recent message"),
  messageGuid: z
    .string()
    .min(1)
    .optional()
    .describe("Defaults to Michael's most recent message in the chat"),
  remove: z.boolean().optional().describe("Take the reaction back instead of adding it"),
});

type ReactParams = z.infer<typeof reactSchema>;

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
  /** Chat of his most recent message, the default target for imessage.react. */
  let lastChatId: number | null = null;
  /** chatId → guid of his most recent message there. */
  const lastIncoming = new Map<number, string>();

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
      // Convert HEIC/HEIF (iPhone default) to JPEG before sending
      if (mimeType.startsWith("image/")) {
        let imageData = base64;
        let imageMimeType = mimeType;

        if (mimeType === "image/heic" || mimeType === "image/heif") {
          try {
            const sharp = (await import("sharp")).default;
            const inputBuffer = Buffer.from(base64, "base64");
            const outputBuffer = await sharp(inputBuffer)
              .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
              .jpeg({ quality: 85, mozjpeg: true })
              .toBuffer();
            imageData = outputBuffer.toString("base64");
            imageMimeType = "image/jpeg";
            ctx?.log.info(
              `Converted HEIC → JPEG: ${(inputBuffer.length / 1024).toFixed(0)}KB → ${(outputBuffer.length / 1024).toFixed(0)}KB`,
            );
          } catch (err) {
            ctx?.log.warn(`HEIC conversion failed, sending raw: ${err}`);
          }
        }

        return {
          type: "image",
          source: {
            type: "base64",
            media_type: imageMimeType,
            data: imageData,
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

  function toSessionContent(contentBlocks: ContentBlock[]): string | ContentBlock[] {
    return contentBlocks.length === 1 && contentBlocks[0].type === "text"
      ? (contentBlocks[0] as TextContentBlock).text
      : contentBlocks;
  }

  async function requestSessionReply(
    source: string,
    contentBlocks: ContentBlock[],
  ): Promise<SessionPromptResult | null> {
    if (!contentBlocks.length) {
      ctx?.log.warn("No valid content blocks to send");
      return null;
    }

    const cwd = cfg.workspaceCwd || process.cwd();
    return (await ctx!.call("session.send_prompt", {
      sessionId: PERSISTENT_SESSION_ID,
      content: toSessionContent(contentBlocks),
      cwd,
      streaming: false,
      source,
    })) as SessionPromptResult;
  }

  async function sendReply(chatId: number, replyText: string, logPrefix: string): Promise<boolean> {
    const trimmed = replyText.trim();
    if (!trimmed) return false;

    ctx?.log.info(`${logPrefix} "${trimmed.substring(0, 50)}..."`);
    await client?.send({ chatId, text: trimmed });
    return true;
  }

  // ── Read receipts, typing, tapbacks (imsg's IMCore bridge) ──
  // Best-effort niceties: without the bridge she still replies, just silently.
  // imsg runs mutations in one FIFO lane, so read → typing → send stay ordered
  // even though these calls aren't awaited.

  /** He sees "Read" and the typing bubble while she thinks. */
  function acknowledge(chatId: number): void {
    void client
      ?.markRead(chatId)
      .catch((err) => ctx?.log.warn(`Couldn't mark chat ${chatId} read: ${err}`));
    void client
      ?.setTyping(chatId, true)
      .catch((err) => ctx?.log.warn(`Couldn't show typing in chat ${chatId}: ${err}`));
  }

  function stopTyping(chatId: number): void {
    void client?.setTyping(chatId, false).catch(() => {});
  }

  /** His newest message in a chat, for a tapback with no explicit target. */
  async function latestFromHim(chatId: number): Promise<string | undefined> {
    const remembered = lastIncoming.get(chatId);
    if (remembered) return remembered;
    const history = (await client?.getHistory(chatId, { limit: 20 })) ?? [];
    return history.find((m) => !m.is_from_me && isAllowedSenderForConfig(m.sender))?.guid;
  }

  async function react(params: ReactParams): Promise<{ ok: true; messageGuid: string }> {
    if (!client) throw new Error("iMessage client not running");
    const chatId = params.chatId ?? lastChatId;
    if (chatId === null) throw new Error("No recent chat: pass chatId");
    const messageGuid = params.messageGuid ?? (await latestFromHim(chatId));
    if (!messageGuid) throw new Error(`No message from an allowed sender in chat ${chatId}`);
    await client.tapback({ chatId, messageGuid, kind: params.kind, remove: params.remove });
    return { ok: true, messageGuid };
  }

  // ── Outside messages (see outside-messages.ts) ─────────────

  function loadMemory(chatId: number): ChatMemory {
    return memoryFor(ctx?.store.get<ChatMemories>(STORE_KEY), chatId);
  }

  function saveMemory(chatId: number, update: (memory: ChatMemory) => ChatMemory): void {
    if (!ctx) return;
    // Re-read before writing: another chat may have saved in the meantime.
    const all = ctx.store.get<ChatMemories>(STORE_KEY) ?? {};
    all[String(chatId)] = update(memoryFor(all, chatId));
    ctx.store.set(STORE_KEY, all);
  }

  /** Her outside messages and his tapbacks since the cursor, before `beforeRowId`. */
  async function findOutside(
    chatId: number,
    memory: ChatMemory,
    beforeRowId: number,
  ): Promise<OutsideContext> {
    if (memory.cursor === undefined || !client) return NO_OUTSIDE;
    try {
      const history = await client.getHistory(chatId, {
        start: new Date(Date.now() - OUTSIDE_WINDOW_MS).toISOString(),
        limit: 60,
      });
      return collectOutside(history, memory, beforeRowId);
    } catch (err) {
      // Context is a nicety; never let it stop a reply.
      ctx?.log.warn(`Couldn't read history for outside messages: ${err}`);
      return NO_OUTSIDE;
    }
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
    lastChatId = message.chat_id;
    lastIncoming.set(message.chat_id, message.guid);
    acknowledge(message.chat_id);

    // Build source for routing
    const source = buildSource(message.chat_id);

    // Anything she sent him outside the session (a notification, another
    // session) goes in front of his message, so his reply has its context,
    // along with any tapbacks he left on her messages since his last one.
    const memory = loadMemory(message.chat_id);
    const outside = await findOutside(message.chat_id, memory, message.rowid);
    if (!isEmptyOutside(outside)) {
      ctx?.log.info(
        `Including ${outside.messages.length} outside message(s) and ${outside.tapbacks.length} tapback(s)`,
      );
    }

    // Build content blocks (handles text + attachments)
    const contentBlocks = await buildContentBlocks({
      ...message,
      text: withOutsideContext(outside, message.text),
    });

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

    let replyText = "";
    try {
      const result = await requestSessionReply(source, contentBlocks);

      if (
        result &&
        (await sendReply(
          message.chat_id,
          result.text || "",
          `Sending reply to chat ${message.chat_id}:`,
        ))
      ) {
        replyText = result.text || "";
        ctx?.emit("imessage.sent", { chatId: message.chat_id, text: result.text });
      }
    } catch (err) {
      ctx?.log.error(`Failed to process message: ${err}`);
      ctx?.emit("imessage.error", { error: String(err), chatId: message.chat_id });
    } finally {
      stopTyping(message.chat_id);
      // His message has been handled either way; her reply (if any) is now in
      // her session, so remember it to keep it out of the next outside batch.
      saveMemory(message.chat_id, (m) => advanceCursor(rememberReply(m, replyText), message.rowid));
    }
  }

  /**
   * Catch up on unanswered messages received while the extension was offline.
   * Checks each allowed-sender chat for messages we haven't replied to within
   * the catchup window. Stateless — uses imsg history as the source of truth.
   */
  async function catchupOnStartup(chats: Array<{ id: number; identifier: string }>): Promise<void> {
    const windowHours = cfg.catchupWindowHours ?? 24;
    const maxMessages = cfg.catchupMaxMessages ?? 20;
    const start = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    for (const chat of chats) {
      if (!isAllowedSenderForConfig(chat.identifier)) continue;

      try {
        const messages = await client!.getHistory(chat.id, {
          start,
          limit: maxMessages + 10, // Extra buffer to find our last reply
          attachments: cfg.includeAttachments,
        });

        if (!messages.length) continue;

        const memory = loadMemory(chat.id);
        const hasContent = (msg: ImsgMessage) =>
          Boolean(msg.text?.trim()) || Boolean(msg.attachments?.length);

        // Messages come in reverse chronological order. With a cursor, his
        // unanswered messages are simply the ones after it. Without one,
        // walk back to the last message from her account (the old rule; a
        // notification sent after his message would wrongly end the walk,
        // which is why the cursor exists).
        const unanswered: typeof messages =
          memory.cursor !== undefined
            ? messages.filter((m) => !m.is_from_me && m.rowid > memory.cursor! && hasContent(m))
            : [];
        if (memory.cursor === undefined) {
          for (const msg of messages) {
            if (msg.is_from_me) break;
            // Skip empty messages and reactions
            if (!hasContent(msg)) continue;
            unanswered.push(msg);
          }
        }

        if (!unanswered.length) {
          ctx?.log.info(`Catchup: ${chat.identifier} — all caught up`);
          // Nothing of his is waiting, so everything here is already
          // accounted for: a safe place to start a missing cursor. Anything
          // sent from now on counts, including the next notification.
          const newest = messages[0]?.rowid;
          if (memory.cursor === undefined && newest !== undefined) {
            saveMemory(chat.id, (m) => advanceCursor(m, newest));
          }
          continue;
        }

        // Cap at maxMessages
        if (unanswered.length > maxMessages) {
          unanswered.length = maxMessages;
        }

        // Reverse to chronological order
        unanswered.reverse();

        ctx?.log.info(`Catchup: ${chat.identifier} — ${unanswered.length} unanswered message(s)`);

        // Build a single prompt with all missed messages for context
        const lines = unanswered.map((msg) => {
          const time = new Date(msg.created_at).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          });
          return `[${time}] ${msg.text || "(attachment)"}`;
        });

        const latestRowId = unanswered[unanswered.length - 1]?.rowid ?? 0;
        const outside = collectOutside(messages, memory, latestRowId);
        const context = formatOutside(outside);

        const catchupBody =
          unanswered.length === 1
            ? unanswered[0].text || "(attachment)"
            : `[Catching up on ${unanswered.length} messages received while I was offline]\n\n${lines.join("\n")}`;
        const catchupPrompt = context
          ? `${context}\n\n[Michael replied]\n${catchupBody}`
          : catchupBody;

        // Build content blocks (include attachments from the most recent message)
        const lastMsg = unanswered[unanswered.length - 1];
        const contentBlocks = await buildContentBlocks({
          ...lastMsg,
          text: catchupPrompt,
        });

        const source = buildSource(chat.id);
        lastChatId = chat.id;
        lastIncoming.set(chat.id, lastMsg.guid);
        acknowledge(chat.id);
        const result = await requestSessionReply(source, contentBlocks).finally(() =>
          stopTyping(chat.id),
        );

        const sent =
          result &&
          (await sendReply(chat.id, result.text || "", `Catchup reply to chat ${chat.id}:`));
        saveMemory(chat.id, (m) =>
          advanceCursor(rememberReply(m, sent ? result.text || "" : ""), latestRowId),
        );
      } catch (err) {
        ctx?.log.error(`Catchup failed for ${chat.identifier}: ${err}`);
      }
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
        name: "imessage.react",
        description:
          "React to a message with a tapback (❤️ 👍 👎 😂 ‼️ ❓, or any emoji). With no target, reacts to Michael's latest message",
        inputSchema: reactSchema,
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

      ctx.log.info("Allowed senders configured", {
        count: cfg.allowedSenders?.length || 0,
      });

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
      let chats: Awaited<ReturnType<ImsgRpcClient["listChats"]>> = [];
      try {
        chats = await client.listChats(20);
        ctx.log.info(`Connected! Found ${chats.length} recent chats`);
      } catch (err) {
        ctx.log.error(`Failed to list chats: ${err}`);
      }

      // Subscribe to watch for new messages first (don't miss anything during catchup)
      try {
        const subId = await client.subscribe({
          attachments: cfg.includeAttachments,
        });
        ctx.log.info(`Subscribed to message watch (subscription: ${subId})`);
      } catch (err) {
        ctx.log.error(`Failed to subscribe: ${err}`);
      }

      ctx.log.info("iMessage extension started");

      // Catch up on missed messages once all extensions are ready
      if (cfg.catchupEnabled !== false && chats.length > 0) {
        const chatsCopy = [...chats];
        ctx.on("gateway.extensions_ready", async () => {
          try {
            await catchupOnStartup(chatsCopy);
          } catch (err) {
            ctx?.log.error(`Catchup failed: ${err}`);
          }
        });
      }
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

        case "imessage.react":
          // Parse here too: the extension host doesn't validate params (#86).
          return await react(reactSchema.parse(params));

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
