#!/usr/bin/env bun
/**
 * Agent Host server entrypoint.
 *
 * Delegates HTTP/WS serving and message routing to createAgentHostServer(),
 * then layers process-level startup/shutdown concerns (force lock clearing,
 * idle session reap).
 */

import { createLogger } from "@claudia/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createAgentHostServer } from "./server";

const log = createLogger("AgentHost", join(homedir(), ".claudia", "logs", "agent-host.log"));

const PORT = 30087;
const FORCE_STARTUP = process.argv.includes("--force");

function parseMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

const IDLE_REAP_INTERVAL_MS = parseMs(process.env.CLAUDIA_AGENT_IDLE_REAP_INTERVAL_MS, 60000);
const IDLE_STALE_MS = parseMs(process.env.CLAUDIA_AGENT_IDLE_STALE_MS, 600000);

function forceClearGatewayLocks(): void {
  if (!FORCE_STARTUP) return;

  const dbPath = join(homedir(), ".claudia", "claudia.db");
  if (!existsSync(dbPath)) {
    log.warn("Force startup requested, but gateway DB does not exist yet", { dbPath });
    return;
  }

  const db = new Database(dbPath);
  const clear = (tableName: string): number => {
    const exists = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName);
    if (!exists) return 0;
    const result = db.query(`DELETE FROM ${tableName}`).run();
    return result.changes;
  };

  try {
    const cleared = {
      extensionProcessLocks: clear("extension_process_locks"),
      memoryExtensionLocks: clear("memory_extension_locks"),
      memoryFileLocks: clear("memory_file_locks"),
    };
    log.warn("Force startup requested; cleared gateway lock tables", cleared);
  } catch (error) {
    log.error("Failed to clear gateway lock tables during force startup", {
      error: String(error),
    });
  } finally {
    db.close();
  }
}

forceClearGatewayLocks();

const ctx = await createAgentHostServer({ port: PORT });

let idleReapRunning = false;
const idleReapTimer = setInterval(async () => {
  if (idleReapRunning) return;
  if (!ctx.sessionHost.reapIdleRunningSessions) return;
  idleReapRunning = true;
  try {
    const closedIds = await ctx.sessionHost.reapIdleRunningSessions(IDLE_STALE_MS);
    if (closedIds.length > 0) {
      for (const [, client] of ctx.clients) {
        for (const sessionId of closedIds) {
          client.subscribedSessions.delete(sessionId);
        }
      }
      log.info("Auto-closed idle SDK sessions", {
        idleMs: IDLE_STALE_MS,
        count: closedIds.length,
        sessions: closedIds.map((id) => id.slice(0, 8)),
      });
    }
  } catch (error) {
    log.warn("Idle session reaper failed", { error: String(error) });
  } finally {
    idleReapRunning = false;
  }
}, IDLE_REAP_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  log.info(`Received ${signal}, shutting down...`);
  clearInterval(idleReapTimer);
  await ctx.stop(signal);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
