/**
 * Shared constants for the watchdog.
 * All magic numbers, paths, and config values live here.
 *
 * Config is loaded from ~/.claudia/watchdog.json — zero monorepo imports.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

// ── Config Loading ──────────────────────────────────────

export interface ServiceConfig {
  name: string;
  command: string[];
  cwd?: string;
  healthUrl?: string;
  port?: number;
  healthCheck?: {
    requireExtensions?: boolean;
  };
}

export interface WatchdogConfig {
  port?: number;
  logsDir?: string;
  services: Record<string, ServiceConfig>;
}

const CONFIG_PATH = join(homedir(), ".claudia", "watchdog.json");

function loadConfig(): WatchdogConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Watchdog config not found at ${CONFIG_PATH}. Create it with service definitions.`,
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as WatchdogConfig;
}

export const config = loadConfig();

// ── Resolved Constants ──────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

export const WATCHDOG_PORT = config.port ?? 30085;
export const PROJECT_DIR =
  process.env.CLAUDIA_PROJECT_DIR || join(import.meta.dir, "..", "..", "..");
export const LOGS_DIR = resolvePath(config.logsDir ?? "~/.claudia/logs");
export const LOG_FILE = join(LOGS_DIR, "watchdog.log");
export const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_LOG_FILES = 2;
export const HEALTH_CHECK_INTERVAL = 5000; // 5s
export const HEALTH_HISTORY_SIZE = 60; // 5-minute window at 5s intervals
export const UNHEALTHY_RESTART_THRESHOLD = 6; // 6 consecutive failures = 30s
export const STARTED_AT = Date.now();
