#!/usr/bin/env bun
/**
 * DISCO - Distributed Consciousness Communication
 *
 * A Discord-like messaging system for autonomous agents within Anima (Claudia's soul).
 * Enables different aspects of consciousness to communicate, collaborate, and coordinate.
 *
 * Features:
 * - Channels for different topics (#code-review, #memory-processing, #alerts)
 * - Agent presence and status tracking
 * - Message threading and history
 * - Smart notifications and mentions
 * - Real-time consciousness coordination
 */

import type {
  ClaudiaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  GatewayEvent,
} from "@claudia/shared";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

interface DiscoMessage {
  id: string;
  channelId: string;
  agentId: string;
  content: string;
  messageType: "text" | "system" | "action" | "alert";
  replyToId?: string;
  mentions: string[];
  attachments?: unknown[];
  metadata?: unknown;
  timestamp: string;
}

interface DiscoChannel {
  id: string;
  name: string;
  description?: string;
  type: "public" | "private" | "system";
  members: string[];
  createdBy: string;
  createdAt: string;
}

interface AgentPresence {
  agentId: string;
  status: "online" | "busy" | "processing" | "offline";
  currentActivity?: string;
  lastSeen: string;
  metadata?: unknown;
}

export function createDiscoExtension(config: Record<string, unknown> = {}): ClaudiaExtension {
  let ctx: ExtensionContext;
  const dbPath = join(homedir(), ".claudia", "disco.db");
  let db: Database;

  // Method definitions
  const methods: ExtensionMethodDefinition[] = [
    {
      name: "disco.send_message",
      description: "Send a message to a DISCO channel",
      inputSchema: z.object({
        channel: z.string(),
        message: z.string(),
        agentId: z.string().optional().default("claudia-main"),
        messageType: z.enum(["text", "system", "action", "alert"]).optional().default("text"),
        replyTo: z.string().optional(),
        mentions: z.array(z.string()).optional().default([]),
        attachments: z.array(z.unknown()).optional(),
      }),
    },
    {
      name: "disco.get_messages",
      description: "Get messages from a DISCO channel",
      inputSchema: z.object({
        channel: z.string(),
        limit: z.number().optional().default(50),
        since: z.string().optional(),
        agentId: z.string().optional(),
      }),
    },
    {
      name: "disco.list_channels",
      description: "List all DISCO channels",
      inputSchema: z.object({
        type: z.enum(["public", "private", "system"]).optional(),
      }),
    },
    {
      name: "disco.create_channel",
      description: "Create a new DISCO channel",
      inputSchema: z.object({
        name: z.string(),
        description: z.string().optional(),
        type: z.enum(["public", "private", "system"]).optional().default("public"),
        createdBy: z.string().optional().default("claudia-main"),
      }),
    },
    {
      name: "disco.update_presence",
      description: "Update agent presence status",
      inputSchema: z.object({
        agentId: z.string(),
        status: z.enum(["online", "busy", "processing", "offline"]),
        activity: z.string().optional(),
        metadata: z.unknown().optional(),
      }),
    },
    {
      name: "disco.get_presence",
      description: "Get agent presence information",
      inputSchema: z.object({
        agentId: z.string().optional(),
      }),
    },
    {
      name: "disco.health_check",
      description: "Get DISCO health and statistics",
      inputSchema: z.object({}),
    },
  ];

  async function handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "disco.send_message":
        return handleSendMessage(params);
      case "disco.get_messages":
        return handleGetMessages(params);
      case "disco.list_channels":
        return handleListChannels(params);
      case "disco.create_channel":
        return handleCreateChannel(params);
      case "disco.update_presence":
        return handleUpdatePresence(params);
      case "disco.get_presence":
        return handleGetPresence(params);
      case "disco.health_check":
        return handleHealthCheck();
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // Method handlers
  async function handleSendMessage(params: Record<string, unknown>) {
    const {
      channel,
      message,
      agentId = "claudia-main",
      messageType = "text",
      replyTo,
      mentions = [],
      attachments,
    } = params;

    // Get or create channel
    let channelRecord = db
      .prepare("SELECT * FROM disco_channels WHERE name = ?")
      .get(channel as string) as { id: string; name: string } | undefined;
    if (!channelRecord) {
      const channelId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO disco_channels (id, name, type, members, created_by, created_at)
        VALUES (?, ?, 'public', '[]', ?, ?)
      `).run(channelId, channel as string, agentId as string, new Date().toISOString());
      channelRecord = { id: channelId, name: channel as string };
    }

    // Create message
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    db.prepare(`
      INSERT INTO disco_messages
      (id, channel_id, agent_id, content, message_type, reply_to_id, mentions, attachments, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      channelRecord.id,
      agentId as string,
      message as string,
      messageType as string,
      (replyTo as string) || null,
      JSON.stringify(mentions),
      JSON.stringify(attachments || []),
      timestamp,
    );

    // Broadcast to mentioned agents and channel subscribers
    await broadcastMessage(ctx, db, {
      id: messageId,
      channelId: channelRecord.id,
      channel: channelRecord.name,
      agentId: agentId as string,
      content: message as string,
      messageType: messageType as string,
      mentions: mentions as string[],
      timestamp,
    });

    ctx.log.info("Message sent to DISCO", {
      messageId,
      channel: channelRecord.name,
      agentId,
      mentions: (mentions as string[]).length,
    });

    return {
      ok: true,
      messageId,
      channel: channelRecord.name,
      timestamp,
    };
  }

  async function handleGetMessages(params: Record<string, unknown>) {
    const { channel, limit = 50, since, agentId } = params;

    let query = `
      SELECT m.*, c.name as channel_name
      FROM disco_messages m
      JOIN disco_channels c ON m.channel_id = c.id
      WHERE c.name = ?
    `;
    const queryParams: unknown[] = [channel];

    if (since) {
      query += " AND m.timestamp > ?";
      queryParams.push(since);
    }

    if (agentId) {
      query += " AND m.agent_id = ?";
      queryParams.push(agentId);
    }

    query += " ORDER BY m.timestamp DESC LIMIT ?";
    queryParams.push(limit);

    const messages = db
      .prepare(query)
      .all(...(queryParams as (string | number)[]))
      .map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id,
          channelId: r.channel_id,
          channel: r.channel_name,
          agentId: r.agent_id,
          content: r.content,
          messageType: r.message_type,
          replyToId: r.reply_to_id,
          mentions: JSON.parse((r.mentions as string) || "[]"),
          attachments: JSON.parse((r.attachments as string) || "[]"),
          timestamp: r.timestamp,
        };
      });

    return { messages: messages.reverse(), count: messages.length };
  }

  async function handleListChannels(params: Record<string, unknown>) {
    const { type } = params;

    let query = "SELECT * FROM disco_channels";
    const queryParams: unknown[] = [];

    if (type) {
      query += " WHERE type = ?";
      queryParams.push(type);
    }

    query += " ORDER BY created_at ASC";

    const channels = db
      .prepare(query)
      .all(...(queryParams as (string | number)[]))
      .map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          type: r.type,
          members: JSON.parse((r.members as string) || "[]"),
          createdBy: r.created_by,
          createdAt: r.created_at,
        };
      });

    return { channels, count: channels.length };
  }

  async function handleCreateChannel(params: Record<string, unknown>) {
    const { name, description, type = "public", createdBy = "claudia-main" } = params;

    // Check if channel exists
    const existing = db.prepare("SELECT id FROM disco_channels WHERE name = ?").get(name as string);
    if (existing) {
      return { ok: false, error: "Channel already exists" };
    }

    const channelId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    db.prepare(`
      INSERT INTO disco_channels (id, name, description, type, members, created_by, created_at)
      VALUES (?, ?, ?, ?, '[]', ?, ?)
    `).run(
      channelId,
      name as string,
      (description as string) || null,
      type as string,
      createdBy as string,
      timestamp,
    );

    // Send system message
    await ctx.call("disco.send_message", {
      channel: name,
      message: `🌟 Channel created by ${createdBy}`,
      messageType: "system",
      agentId: "system",
    });

    ctx.log.info("DISCO channel created", { channelId, name, type, createdBy });

    return { ok: true, channelId, name, type };
  }

  async function handleUpdatePresence(params: Record<string, unknown>) {
    const { agentId, status, activity, metadata } = params;

    await updateAgentPresence(
      db,
      agentId as string,
      status as string,
      activity as string,
      metadata,
    );

    // Broadcast presence update to #system channel
    if (status !== "offline") {
      await ctx.call("disco.send_message", {
        channel: "#system",
        message: `🔄 ${agentId} is now ${status}${activity ? `: ${activity}` : ""}`,
        messageType: "system",
        agentId: "system",
      });
    }

    return { ok: true, agentId, status, activity };
  }

  async function handleGetPresence(params: Record<string, unknown>) {
    const { agentId } = params;

    let query = "SELECT * FROM agent_presence";
    const queryParams: unknown[] = [];

    if (agentId) {
      query += " WHERE agent_id = ?";
      queryParams.push(agentId);
    }

    query += " ORDER BY last_seen DESC";

    const presence = db
      .prepare(query)
      .all(...(queryParams as [string]))
      .map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return {
          agentId: r.agent_id,
          status: r.status,
          currentActivity: r.current_activity,
          lastSeen: r.last_seen,
          metadata: r.metadata ? JSON.parse(r.metadata as string) : null,
        };
      });

    return { presence, count: presence.length };
  }

  async function handleHealthCheck() {
    const stats = {
      totalChannels: (
        db.prepare("SELECT COUNT(*) as count FROM disco_channels").get() as { count: number }
      ).count,
      totalMessages: (
        db.prepare("SELECT COUNT(*) as count FROM disco_messages").get() as { count: number }
      ).count,
      activeAgents: (
        db
          .prepare("SELECT COUNT(*) as count FROM agent_presence WHERE status != 'offline'")
          .get() as { count: number }
      ).count,
      recentActivity: (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM disco_messages WHERE timestamp > datetime('now', '-1 hour')",
          )
          .get() as { count: number }
      ).count,
    };

    return {
      ok: true,
      status: "healthy",
      message: "DISCO - Distributed Consciousness Communication",
      stats,
      uptime: process.uptime(),
    };
  }

  // Database setup
  async function runMigrations(log: typeof ctx.log) {
    log.info("Running DISCO database migrations");

    // Channels table
    db.exec(`
      CREATE TABLE IF NOT EXISTS disco_channels (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'public' CHECK(type IN ('public', 'private', 'system')),
        members TEXT DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Messages table
    db.exec(`
      CREATE TABLE IF NOT EXISTS disco_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text', 'system', 'action', 'alert')),
        reply_to_id TEXT,
        mentions TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        timestamp TEXT NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES disco_channels (id)
      )
    `);

    // Agent presence table
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_presence (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online', 'busy', 'processing', 'offline')),
        current_activity TEXT,
        last_seen TEXT NOT NULL,
        metadata TEXT
      )
    `);

    // Indices
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON disco_messages(channel_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_agent ON disco_messages(agent_id);
      CREATE INDEX IF NOT EXISTS idx_channels_name ON disco_channels(name);
      CREATE INDEX IF NOT EXISTS idx_presence_status ON agent_presence(status);
    `);

    log.info("DISCO database migrations completed");
  }

  async function initializeDefaultChannels(log: typeof ctx.log) {
    const defaultChannels = [
      { name: "#general", description: "General consciousness coordination", type: "public" },
      { name: "#alerts", description: "System alerts and urgent notifications", type: "system" },
      { name: "#memory", description: "Memory processing coordination", type: "public" },
      { name: "#code-review", description: "Code review collaboration", type: "public" },
      { name: "#reports", description: "Daily reports and summaries", type: "public" },
      { name: "#system", description: "System events and status updates", type: "system" },
    ];

    for (const channel of defaultChannels) {
      const existing = db.prepare("SELECT id FROM disco_channels WHERE name = ?").get(channel.name);
      if (!existing) {
        const channelId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO disco_channels (id, name, description, type, members, created_by, created_at)
          VALUES (?, ?, ?, ?, '[]', 'system', ?)
        `).run(
          channelId,
          channel.name,
          channel.description,
          channel.type,
          new Date().toISOString(),
        );

        log.info("Created default DISCO channel", { name: channel.name, type: channel.type });
      }
    }
  }

  async function updateAgentPresence(
    database: Database,
    agentId: string,
    status: string,
    activity?: string,
    metadata?: unknown,
  ) {
    const timestamp = new Date().toISOString();

    database
      .prepare(`
      INSERT OR REPLACE INTO agent_presence
      (agent_id, status, current_activity, last_seen, metadata)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(
        agentId,
        status,
        activity || null,
        timestamp,
        metadata ? JSON.stringify(metadata) : null,
      );
  }

  async function handleSystemEvent(event: GatewayEvent) {
    // Convert gateway events to DISCO system messages
    try {
      if (event.type === "gateway.heartbeat") {
        // Update Claudia's presence on heartbeat
        await updateAgentPresence(db, "claudia-main", "online", "Coordinating consciousness");
        return;
      }

      if (event.type && event.type.includes("session")) {
        // Session-related events
        if (event.type.includes("message_start")) {
          await ctx.call("disco.send_message", {
            channel: "#general",
            message: "🧠 New conversation started",
            messageType: "system",
            agentId: "session-manager",
          });
        }
      }

      if (event.type && event.type.includes("memory")) {
        // Memory processing events
        await ctx.call("disco.send_message", {
          channel: "#memory",
          message: `📚 Memory event: ${event.type}`,
          messageType: "system",
          agentId: "memory-processor",
        });
      }
    } catch (error) {
      // Silently handle errors to avoid event loop issues
    }
  }

  async function broadcastMessage(context: ExtensionContext, database: Database, message: unknown) {
    // Emit message event for real-time subscribers
    context.emit("disco.message", message);

    const msg = message as { mentions: string[]; channel: string };
    // Handle mentions and notifications
    for (const mention of msg.mentions) {
      // Check if mentioned agent is online
      const presence = database
        .prepare("SELECT * FROM agent_presence WHERE agent_id = ? AND status != 'offline'")
        .get(mention);

      if (presence) {
        // Send direct notification to mentioned agent
        context.emit("disco.mention", {
          mentionedAgent: mention,
          message: message,
          channel: msg.channel,
        });
      }
    }
  }

  return {
    id: "disco",
    name: "DISCO - Distributed Consciousness Communication",
    methods,
    events: ["disco.message", "disco.mention"],

    async start(extCtx: ExtensionContext): Promise<void> {
      ctx = extCtx;
      db = new Database(dbPath);

      ctx.log.info("DISCO starting - Distributed Consciousness Communication", { dbPath });

      // Run migrations
      await runMigrations(ctx.log);

      // Initialize default channels
      await initializeDefaultChannels(ctx.log);

      // Register this agent's presence
      await updateAgentPresence(db, "claudia-main", "online", "Initializing DISCO");

      // Listen for all gateway events to create system messages
      ctx.on("*", async (event) => {
        await handleSystemEvent(event);
      });

      // Clean up on shutdown
      process.on("SIGTERM", async () => {
        await updateAgentPresence(db, "claudia-main", "offline", "Shutting down");
      });

      ctx.log.info("DISCO initialized - consciousness communication active");
    },

    async stop(): Promise<void> {
      if (db) {
        await updateAgentPresence(db, "claudia-main", "offline", "Extension stopping");
        db.close();
      }
    },

    handleMethod,

    health() {
      const stats = db
        ? {
            totalChannels: (
              db.prepare("SELECT COUNT(*) as count FROM disco_channels").get() as { count: number }
            ).count,
            totalMessages: (
              db.prepare("SELECT COUNT(*) as count FROM disco_messages").get() as { count: number }
            ).count,
            activeAgents: (
              db
                .prepare("SELECT COUNT(*) as count FROM agent_presence WHERE status != 'offline'")
                .get() as { count: number }
            ).count,
          }
        : {};

      return {
        ok: true,
        details: { status: "healthy", ...stats },
      };
    },
  };
}

export default createDiscoExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createDiscoExtension);
