/**
 * Claudia Configuration Loader
 *
 * Features:
 * - JSON5 format (supports comments, trailing commas)
 * - Environment variable interpolation: "${ENV_VAR}"
 * - Type-safe config
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";
import { generateToken } from "./auth";
import type { WebStaticPath } from "./types";

// ============================================================================
// Types
// ============================================================================

export interface GatewayConfig {
  port: number;
  host: string;
  /** Public endpoint hostname for remote clients (e.g., "claudia-gateway.kiliman.dev") */
  endpoint?: string;
  /** Heartbeat interval in milliseconds for broadcasting to extensions (default: 300000 = 5min) */
  heartbeatIntervalMs?: number;
  /** Bearer token for gateway authentication. Auto-generated on first run if missing. */
  token?: string;
}

export type ThinkingEffort = "low" | "medium" | "high" | "max";

export interface ImageProcessingConfig {
  /** Enable automatic image resizing/compression before sending to API */
  enabled: boolean;
  /** Target max width in pixels (default: 1600) */
  maxWidth: number;
  /** Target max height in pixels (default: 1600) */
  maxHeight: number;
  /** Target max file size in bytes (default: 1MB) */
  maxFileSizeBytes: number;
  /** Output format: 'webp' | 'jpeg' | 'png' (default: 'webp') */
  format: "webp" | "jpeg" | "png";
  /** Output quality 1-100 (default: 85) */
  quality: number;
}

export interface SessionConfig {
  model: string;
  thinking: boolean;
  effort: ThinkingEffort;
  systemPrompt: string | null;
  /** Additional skill paths (additive to default probe paths) */
  skills: {
    paths: string[];
  };
  /** Image processing settings */
  imageProcessing: ImageProcessingConfig;
}

export interface ExtensionConfig {
  enabled: boolean;
  /** Source prefixes this extension handles for routing (e.g., ["imessage"]) */
  sourceRoutes?: string[];
  /** Enable Bun --hot for live reloading (default: false). Set true explicitly
   *  for rapid iteration when developing an extension. */
  hot?: boolean;
  /**
   * Optional static URL path overrides. Merged with the extension's code-level
   * `webStatic` declarations by `path`: a config entry replaces a code entry
   * with the same `path`; new entries get appended. Useful for relocating
   * homedir-based paths (e.g., point /audiobooks/static at a different folder).
   */
  webStatic?: WebStaticPath[];
  config: Record<string, unknown>;
  /**
   * Public, client-safe configuration exposed to the SPA. Returned alongside
   * the extension's web bundle URL via `gateway.list_web_contributions` /
   * `/api/web-contributions`, and read on the client through
   * `useExtensionConfig(id)` from `@anima/ui`.
   *
   * Keep this strictly to non-secret values (URLs, feature flags, defaults).
   * Server-only secrets — API keys, tokens, paths — belong in `config`.
   */
  webConfig?: Record<string, unknown>;
}

export type ExtensionsConfig = Record<string, ExtensionConfig>;

export interface AgentHostConfig {
  /** Agent-host WebSocket URL */
  url: string;
  /** Agent-host HTTP port (for watchdog health checks) */
  port: number;
  /** Automatic MCP tools exposed by gateway-loaded extensions */
  extensionMcp?: {
    enabled?: boolean;
    serverName?: string;
    url?: string;
    alwaysLoad?: boolean;
  };
  /** Codex provider configuration */
  codex?: {
    apiKey?: string;
    cliPath?: string;
    model?: string;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    autoApprove?: boolean;
    personality?: string;
    cwd?: string;
    preambles?: { subagent?: string; review?: string; test?: string };
  };
}

export interface FederationPeer {
  id: string;
  url: string;
  role: "primary" | "replica";
}

export interface FederationConfig {
  enabled: boolean;
  nodeId: string;
  peers: FederationPeer[];
}

export interface AnimaConfig {
  gateway: GatewayConfig;
  session: SessionConfig;
  extensions: ExtensionsConfig;
  agentHost: AgentHostConfig;
  federation: FederationConfig;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: AnimaConfig = {
  gateway: {
    port: 30086,
    host: "localhost",
    heartbeatIntervalMs: 300000, // 5 minutes
  },
  session: {
    model: "claude-opus-4-6",
    thinking: false,
    effort: "medium",
    systemPrompt: null,
    skills: {
      paths: [],
    },
    imageProcessing: {
      enabled: true,
      maxWidth: 1600,
      maxHeight: 1600,
      maxFileSizeBytes: 1024 * 1024, // 1MB
      format: "webp",
      quality: 85,
    },
  },
  extensions: {},
  agentHost: {
    url: "ws://localhost:30087/ws",
    port: 30087,
  },
  federation: {
    enabled: false,
    nodeId: "default",
    peers: [],
  },
};

// ============================================================================
// Environment Variable Interpolation
// ============================================================================

/**
 * Replace ${ENV_VAR} patterns with process.env values
 * Supports nested objects and arrays
 */
function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Match ${VAR_NAME} pattern
    return obj.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
      const value = process.env[envVar];
      if (value === undefined) {
        console.warn(`[Config] Warning: Environment variable ${envVar} is not set`);
        return "";
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }

  return obj;
}

// ============================================================================
// Config Loader
// ============================================================================

let cachedConfig: AnimaConfig | null = null;

/**
 * Load configuration from anima.json
 *
 * Search order:
 * 1. explicit configPath argument
 * 2. ANIMA_CONFIG env var
 * 3. ~/.anima/anima.json
 */
export function loadConfig(configPath?: string): AnimaConfig {
  if (cachedConfig && !configPath) {
    return cachedConfig;
  }

  // Determine config file path
  // Search order: explicit path → env var → ~/.anima/anima.json
  const configHome = process.env.ANIMA_HOME || homedir();
  const paths = [
    configPath,
    process.env.ANIMA_CONFIG,
    join(configHome, ".anima", "anima.json"),
  ].filter(Boolean) as string[];

  let rawConfig: Partial<AnimaConfig> | null = null;
  let loadedFrom: string | null = null;

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        rawConfig = JSON5.parse(content);
        loadedFrom = path;
        break;
      } catch (error) {
        throw new Error(`[Config] Error parsing ${path}: ${String(error)}`);
      }
    }
  }

  if (!loadedFrom || !rawConfig) {
    const searched = paths.length > 0 ? paths.join(", ") : "(none)";
    throw new Error(
      `[Config] No config file found. Searched: ${searched}. Copy anima.example.json to ~/.anima/anima.json`,
    );
  }

  // Interpolate environment variables
  const interpolated = interpolateEnvVars(rawConfig) as Partial<AnimaConfig>;

  // Merge with defaults
  const config: AnimaConfig = {
    gateway: { ...DEFAULT_CONFIG.gateway, ...interpolated.gateway },
    session: { ...DEFAULT_CONFIG.session, ...interpolated.session },
    extensions: interpolated.extensions ?? DEFAULT_CONFIG.extensions,
    agentHost: { ...DEFAULT_CONFIG.agentHost, ...interpolated.agentHost },
    federation: { ...DEFAULT_CONFIG.federation, ...interpolated.federation },
  };

  cachedConfig = config;
  return config;
}

/**
 * Get extension config by ID
 */
export function getExtensionConfig(id: string): ExtensionConfig | undefined {
  const config = loadConfig();
  return config.extensions[id];
}

/**
 * Check if extension is enabled
 */
export function isExtensionEnabled(id: string): boolean {
  const ext = getExtensionConfig(id);
  return ext?.enabled ?? false;
}

/**
 * Get the public, client-safe `webConfig` slice for an extension. Returns
 * an empty object when the extension declares no `webConfig` so callers can
 * destructure without null checks.
 */
export function getExtensionWebConfig(id: string): Record<string, unknown> {
  return getExtensionConfig(id)?.webConfig ?? {};
}

/**
 * Get all enabled extensions as [id, config] pairs
 */
export function getEnabledExtensions(): [string, ExtensionConfig][] {
  const config = loadConfig();
  return Object.entries(config.extensions).filter(([_, ext]) => ext.enabled);
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

// ============================================================================
// Token Management
// ============================================================================

/**
 * Resolve the config file path (same search order as loadConfig).
 */
function resolveConfigPath(configPath?: string): string {
  const configHome = process.env.ANIMA_HOME || homedir();
  const paths = [
    configPath,
    process.env.ANIMA_CONFIG,
    join(configHome, ".anima", "anima.json"),
  ].filter(Boolean) as string[];

  for (const path of paths) {
    if (existsSync(path)) return path;
  }

  return join(configHome, ".anima", "anima.json");
}

/**
 * Write a token into the config file's gateway section.
 * Uses targeted insertion to preserve JSON5 comments and formatting.
 */
export function writeConfigToken(token: string, configPath?: string): void {
  const path = resolveConfigPath(configPath);
  const content = readFileSync(path, "utf-8");

  // If token already exists in the gateway block, replace it
  const tokenPattern = /("token"\s*:\s*)"[^"]*"/;
  if (tokenPattern.test(content)) {
    const updated = content.replace(tokenPattern, `$1"${token}"`);
    writeFileSync(path, updated, "utf-8");
  } else {
    // Insert after the opening brace of the "gateway" block
    const gatewayPattern = /("gateway"\s*:\s*\{)/;
    const match = content.match(gatewayPattern);
    if (match && match.index !== undefined) {
      const insertPos = match.index + match[0].length;
      const updated =
        content.slice(0, insertPos) + `\n    "token": "${token}",` + content.slice(insertPos);
      writeFileSync(path, updated, "utf-8");
    } else {
      throw new Error(
        `Could not find "gateway" section in ${path}. Add it manually: "gateway": { "token": "${token}" }`,
      );
    }
  }

  // Clear cache so next loadConfig picks up the new token
  clearConfigCache();
}

/**
 * Ensure a gateway token exists. If missing, generates one and writes it to config.
 * Returns the token (existing or newly generated).
 */
export function ensureToken(configPath?: string): { token: string; generated: boolean } {
  const config = loadConfig(configPath);
  if (config.gateway.token) {
    return { token: config.gateway.token, generated: false };
  }

  const token = generateToken();
  writeConfigToken(token, configPath);
  return { token, generated: true };
}
