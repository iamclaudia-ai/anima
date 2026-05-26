#!/usr/bin/env bun
/**
 * Agent Host server entrypoint.
 *
 * Delegates HTTP/WS serving and message routing to createAgentHostServer(),
 * then layers process-level startup/shutdown concerns (force lock clearing,
 * idle session reap).
 */

import { createLogger, loadConfig } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createAgentHostServer } from "./server";
import { killSession, listTmuxSessions } from "./providers/cli/tmux";

const log = createLogger("AgentHost", join(homedir(), ".anima", "logs", "agent-host.log"));

const PORT = 30087;
const FORCE_STARTUP = process.argv.includes("--force");

function parseMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

const animaConfig = loadConfig();
const agentHostConfig = animaConfig.agentHost;

// anima.json wins; env vars override (handy for one-off runs); defaults last.
const IDLE_STALE_MS = parseMs(
  process.env.ANIMA_AGENT_IDLE_STALE_MS,
  agentHostConfig.idleStaleMs ?? 7_200_000,
);
const IDLE_REAP_INTERVAL_MS = parseMs(
  process.env.ANIMA_AGENT_IDLE_REAP_INTERVAL_MS,
  agentHostConfig.reapIntervalMs ?? 60_000,
);
const REAP_TMUX_ORPHANS = agentHostConfig.reapTmuxOrphans !== false;

function forceClearGatewayLocks(): void {
  if (!FORCE_STARTUP) return;

  const dbPath = join(homedir(), ".anima", "anima.db");
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

/**
 * Reap orphan `anima-session-*` tmux panes from the tmux-wrap PreToolUse hook.
 * Keeps any pane with an attached client (human is in it) and any pane whose
 * tmux activity timestamp is within the idle threshold. The corresponding
 * `anima-cli-*` panes are owned by the agent-host session reaper, not this one.
 */
function reapOrphanTmuxPanes(staleMs: number): number {
  const cutoffSec = (Date.now() - staleMs) / 1000;
  let killed = 0;
  for (const s of listTmuxSessions()) {
    if (!s.name.startsWith("anima-session-")) continue;
    if (s.attached) continue;
    if (s.activitySec >= cutoffSec) continue;
    killSession(s.name);
    log.info("Reaped orphan tmux pane", {
      name: s.name,
      idleSec: Math.floor(Date.now() / 1000 - s.activitySec),
    });
    killed++;
  }
  return killed;
}

let idleReapRunning = false;
const idleReapTimer = setInterval(async () => {
  if (idleReapRunning) return;
  idleReapRunning = true;
  try {
    if (ctx.sessionHost.reapIdleRunningSessions) {
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
    }
    if (REAP_TMUX_ORPHANS) {
      reapOrphanTmuxPanes(IDLE_STALE_MS);
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

// Prevent unhandled SDK errors from crashing the process.
// The most common culprit is "ProcessTransport is not ready for writing" which
// fires when a zombie session's underlying claude process has died. We close the
// offending session so it can be cleanly lazy-resumed on the next prompt.
function handleUnhandledError(error: unknown, origin: string): void {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("ProcessTransport is not ready")) {
    log.warn("Caught unhandled ProcessTransport error — closing zombie sessions", {
      origin,
      error: msg,
    });
    // Close any session whose transport is dead so it can lazy-resume cleanly
    try {
      for (const info of ctx.sessionHost.list()) {
        if (!(info as Record<string, unknown>).isProcessRunning) {
          const id = (info as Record<string, unknown>).sessionId as string;
          ctx.sessionHost.close(id).catch(() => {});
          log.warn("Closed zombie session", { sessionId: id.slice(0, 8) });
        }
      }
    } catch {
      // best-effort
    }
    return;
  }
  // For all other unhandled errors, log and exit so the watchdog restarts us cleanly
  log.error(`Unhandled ${origin}`, { error: msg });
  process.exit(1);
}

process.on("uncaughtException", (error) => handleUnhandledError(error, "uncaughtException"));
process.on("unhandledRejection", (reason) => handleUnhandledError(reason, "unhandledRejection"));
