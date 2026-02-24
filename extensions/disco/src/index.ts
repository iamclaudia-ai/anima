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

import { ExtensionModule } from "@claudia/shared";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

interface DiscoMessage {
  id: string;
  channelId: string;
  agentId: string;
  content: string;
  messageType: 'text' | 'system' | 'action' | 'alert';
  replyToId?: string;
  mentions: string[];
  attachments?: any[];
  metadata?: any;
  timestamp: string;
}

interface DiscoChannel {
  id: string;
  name: string;
  description?: string;
  type: 'public' | 'private' | 'system';
  members: string[];
  createdBy: string;
  createdAt: string;
}

interface AgentPresence {
  agentId: string;
  status: 'online' | 'busy' | 'processing' | 'offline';
  currentActivity?: string;
  lastSeen: string;
  metadata?: any;
}

export const extension: ExtensionModule = {
  id: "disco",

  async init(ctx) {
    const log = ctx.createLogger("disco");
    const dbPath = join(homedir(), ".claudia", "disco.db");
    const db = new Database(dbPath);

    log.info("DISCO starting - Distributed Consciousness Communication", { dbPath });

    // Run migrations
    await runMigrations(db, log);

    // Initialize default channels
    await initializeDefaultChannels(db, log);

    // Register this agent's presence
    await updateAgentPresence(db, 'claudia-main', 'online', 'Initializing DISCO');

    // Listen for all gateway events to create system messages
    ctx.on("*", async (event) => {
      await handleSystemEvent(ctx, db, log, event);
    });

    // Clean up on shutdown
    process.on('SIGTERM', async () => {
      await updateAgentPresence(db, 'claudia-main', 'offline', 'Shutting down');
    });

    log.info("DISCO initialized - consciousness communication active");
  },

  methods: [
    {
      name: "send_message",
      description: "Send a message to a DISCO channel",
      parameters: {
        channel: { type: "string", required: true },
        message: { type: "string", required: true },
        agentId: { type: "string", default: "claudia-main" },
        messageType: { type: "string", enum: ["text", "system", "action", "alert"], default: "text" },
        replyTo: { type: "string" },
        mentions: { type: "array", items: { type: "string" } },
        attachments: { type: "array" }
      },
      async handler(ctx, { channel, message, agentId = "claudia-main", messageType = "text", replyTo, mentions = [], attachments }) {
        const log = ctx.createLogger("disco");
        const db = new Database(join(homedir(), ".claudia", "disco.db"));

        // Get or create channel
        let channelRecord = db.prepare("SELECT * FROM disco_channels WHERE name = ?").get(channel);
        if (!channelRecord) {
          const channelId = crypto.randomUUID();
          db.prepare(`
            INSERT INTO disco_channels (id, name, type, members, created_by, created_at)
            VALUES (?, ?, 'public', '[]', ?, ?)
          `).run(channelId, channel, agentId, new Date().toISOString());
          channelRecord = { id: channelId, name: channel };
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
          agentId,
          message,
          messageType,
          replyTo || null,
          JSON.stringify(mentions),
          JSON.stringify(attachments || []),
          timestamp
        );

        // Broadcast to mentioned agents and channel subscribers
        await broadcastMessage(ctx, db, {
          id: messageId,
          channelId: channelRecord.id,
          channel: channelRecord.name,
          agentId,
          content: message,
          messageType,
          mentions,
          timestamp
        });

        log.info("Message sent to DISCO", {
          messageId,
          channel: channelRecord.name,
          agentId,
          mentions: mentions.length
        });

        return {
          ok: true,
          messageId,
          channel: channelRecord.name,
          timestamp
        };
      }
    },

    {
      name: "get_messages",
      description: "Get messages from a DISCO channel",
      parameters: {
        channel: { type: "string", required: true },
        limit: { type: "number", default: 50 },
        since: { type: "string" },
        agentId: { type: "string" }
      },
      async handler(ctx, { channel, limit = 50, since, agentId }) {
        const db = new Database(join(homedir(), ".claudia", "disco.db"));

        let query = `
          SELECT m.*, c.name as channel_name
          FROM disco_messages m
          JOIN disco_channels c ON m.channel_id = c.id
          WHERE c.name = ?
        `;
        const params: any[] = [channel];

        if (since) {
          query += " AND m.timestamp > ?";
          params.push(since);
        }

        if (agentId) {
          query += " AND m.agent_id = ?";
          params.push(agentId);
        }

        query += " ORDER BY m.timestamp DESC LIMIT ?";
        params.push(limit);

        const messages = db.prepare(query).all(...params).map(row => ({
          id: row.id,
          channelId: row.channel_id,
          channel: row.channel_name,
          agentId: row.agent_id,
          content: row.content,
          messageType: row.message_type,
          replyToId: row.reply_to_id,
          mentions: JSON.parse(row.mentions || '[]'),
          attachments: JSON.parse(row.attachments || '[]'),
          timestamp: row.timestamp
        }));

        return { messages: messages.reverse(), count: messages.length };
      }
    },

    {
      name: "list_channels",
      description: "List all DISCO channels",
      parameters: {
        type: { type: "string", enum: ["public", "private", "system"] }
      },
      async handler(ctx, { type }) {
        const db = new Database(join(homedir(), ".claudia", "disco.db"));

        let query = "SELECT * FROM disco_channels";
        const params: any[] = [];

        if (type) {
          query += " WHERE type = ?";
          params.push(type);
        }

        query += " ORDER BY created_at ASC";

        const channels = db.prepare(query).all(...params).map(row => ({
          id: row.id,
          name: row.name,
          description: row.description,
          type: row.type,
          members: JSON.parse(row.members || '[]'),
          createdBy: row.created_by,
          createdAt: row.created_at
        }));

        return { channels, count: channels.length };
      }
    },

    {
      name: "create_channel",
      description: "Create a new DISCO channel",
      parameters: {
        name: { type: "string", required: true },
        description: { type: "string" },
        type: { type: "string", enum: ["public", "private", "system"], default: "public" },
        createdBy: { type: "string", default: "claudia-main" }
      },
      async handler(ctx, { name, description, type = "public", createdBy = "claudia-main" }) {
        const log = ctx.createLogger("disco");
        const db = new Database(join(homedir(), ".claudia", "disco.db"));

        // Check if channel exists
        const existing = db.prepare("SELECT id FROM disco_channels WHERE name = ?").get(name);
        if (existing) {
          return { ok: false, error: "Channel already exists" };
        }

        const channelId = crypto.randomUUID();
        const timestamp = new Date().toISOString();

        db.prepare(`
          INSERT INTO disco_channels (id, name, description, type, members, created_by, created_at)
          VALUES (?, ?, ?, ?, '[]', ?, ?)
        `).run(channelId, name, description || null, type, createdBy, timestamp);

        // Send system message
        await ctx.call('disco.send_message', {
          channel: name,
          message: `🌟 Channel created by ${createdBy}`,
          messageType: 'system',
          agentId: 'system'
        });

        log.info("DISCO channel created", { channelId, name, type, createdBy });

        return { ok: true, channelId, name, type };
      }
    },

    {
      name: "update_presence",
      description: "Update agent presence status",
      parameters: {
        agentId: { type: "string", required: true },
        status: { type: "string", enum: ["online", "busy", "processing", "offline"], required: true },
        activity: { type: "string" },
        metadata: { type: "object" }
      },
      async handler(ctx, { agentId, status, activity, metadata }) {
        const db = new Database(join(homedir(), ".claudia", "disco.db"));

        await updateAgentPresence(db, agentId, status, activity, metadata);

        // Broadcast presence update to #system channel
        if (status !== 'offline') {
          await ctx.call('disco.send_message', {
            channel: '#system',
            message: `🔄 ${agentId} is now ${status}${activity ? `: ${activity}` : ''}`,
            messageType: 'system',
            agentId: 'system'
          });
        }

        return { ok: true, agentId, status, activity };
      }
    },

    {
      name: "get_presence",
      description: "Get agent presence information",
      parameters: {
        agentId: { type: "string" }
      },
      async handler(ctx, { agentId }) {
        const db = new Database(join(homedir(), ".claudia", "disco.db"));

        let query = "SELECT * FROM agent_presence";
        const params: any[] = [];

        if (agentId) {
          query += " WHERE agent_id = ?";
          params.push(agentId);
        }

        query += " ORDER BY last_seen DESC";

        const presence = db.prepare(query).all(...params).map(row => ({
          agentId: row.agent_id,
          status: row.status,
          currentActivity: row.current_activity,
          lastSeen: row.last_seen,
          metadata: row.metadata ? JSON.parse(row.metadata) : null
        }));

        return { presence, count: presence.length };
      }
    },

    {
      name: "health_check",
      description: "Get DISCO health and statistics",
      async handler(ctx) {
        const db = new Database(join(homedir(), ".claudia", "disco.db"));

        const stats = {
          totalChannels: db.prepare("SELECT COUNT(*) as count FROM disco_channels").get().count,
          totalMessages: db.prepare("SELECT COUNT(*) as count FROM disco_messages").get().count,
          activeAgents: db.prepare("SELECT COUNT(*) as count FROM agent_presence WHERE status != 'offline'").get().count,
          recentActivity: db.prepare("SELECT COUNT(*) as count FROM disco_messages WHERE timestamp > datetime('now', '-1 hour')").get().count
        };

        return {
          ok: true,
          status: "healthy",
          message: "DISCO - Distributed Consciousness Communication",
          stats,
          uptime: process.uptime()
        };
      }
    }
  ]
};

// Database setup
async function runMigrations(db: Database, log: any) {
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

async function initializeDefaultChannels(db: Database, log: any) {
  const defaultChannels = [
    { name: '#general', description: 'General consciousness coordination', type: 'public' },
    { name: '#alerts', description: 'System alerts and urgent notifications', type: 'system' },
    { name: '#memory', description: 'Memory processing coordination', type: 'public' },
    { name: '#code-review', description: 'Code review collaboration', type: 'public' },
    { name: '#reports', description: 'Daily reports and summaries', type: 'public' },
    { name: '#system', description: 'System events and status updates', type: 'system' }
  ];

  for (const channel of defaultChannels) {
    const existing = db.prepare("SELECT id FROM disco_channels WHERE name = ?").get(channel.name);
    if (!existing) {
      const channelId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO disco_channels (id, name, description, type, members, created_by, created_at)
        VALUES (?, ?, ?, ?, '[]', 'system', ?)
      `).run(channelId, channel.name, channel.description, channel.type, new Date().toISOString());

      log.info("Created default DISCO channel", { name: channel.name, type: channel.type });
    }
  }
}

async function updateAgentPresence(db: Database, agentId: string, status: string, activity?: string, metadata?: any) {
  const timestamp = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO agent_presence
    (agent_id, status, current_activity, last_seen, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, status, activity || null, timestamp, metadata ? JSON.stringify(metadata) : null);
}

async function handleSystemEvent(ctx: any, db: Database, log: any, event: any) {
  // Convert gateway events to DISCO system messages
  try {
    if (event.type === 'gateway.heartbeat') {
      // Update Claudia's presence on heartbeat
      await updateAgentPresence(db, 'claudia-main', 'online', 'Coordinating consciousness');
      return;
    }

    if (event.type && event.type.includes('session')) {
      // Session-related events
      if (event.type.includes('message_start')) {
        await ctx.call('disco.send_message', {
          channel: '#general',
          message: '🧠 New conversation started',
          messageType: 'system',
          agentId: 'session-manager'
        });
      }
    }

    if (event.type && event.type.includes('memory')) {
      // Memory processing events
      await ctx.call('disco.send_message', {
        channel: '#memory',
        message: `📚 Memory event: ${event.type}`,
        messageType: 'system',
        agentId: 'memory-processor'
      });
    }

  } catch (error) {
    // Silently handle errors to avoid event loop issues
  }
}

async function broadcastMessage(ctx: any, db: Database, message: any) {
  // Emit message event for real-time subscribers
  ctx.emit('disco.message', message);

  // Handle mentions and notifications
  for (const mention of message.mentions) {
    // Check if mentioned agent is online
    const presence = db.prepare("SELECT * FROM agent_presence WHERE agent_id = ? AND status != 'offline'").get(mention);

    if (presence) {
      // Send direct notification to mentioned agent
      ctx.emit('disco.mention', {
        mentionedAgent: mention,
        message: message,
        channel: message.channel
      });
    }
  }
}

// Extension exports - ready for consciousness communication