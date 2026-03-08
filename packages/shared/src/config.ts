/**
 * Claudia Configuration Loader
 *
 * Features:
 * - JSON5 format (supports comments, trailing commas)
 * - Environment variable interpolation: "${ENV_VAR}"
 * - Type-safe config
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";

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
  /** Enable Bun --hot for live reloading (default: true). Set false for extensions
   *  that manage long-lived processes (e.g. session) where HMR would be disruptive. */
  hot?: boolean;
  config: Record<string, unknown>;
}

export type ExtensionsConfig = Record<string, ExtensionConfig>;

export interface AgentHostConfig {
  /** Agent-host WebSocket URL */
  url: string;
  /** Agent-host HTTP port (for watchdog health checks) */
  port: number;
  /** Task-agent configuration (currently Codex-backed) */
  codex?: {
    apiKey?: string;
    cliPath?: string;
    model?: string;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    autoApprove?: boolean;
    personality?: string;
    cwd?: string;
    preambles?: { task?: string; review?: string; test?: string };
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

export interface ClaudiaConfig {
  gateway: GatewayConfig;
  session: SessionConfig;
  extensions: ExtensionsConfig;
  agentHost: AgentHostConfig;
  federation: FederationConfig;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: ClaudiaConfig = {
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

let cachedConfig: ClaudiaConfig | null = null;

/**
 * Load configuration from claudia.json
 *
 * Search order:
 * 1. explicit configPath argument
 * 2. CLAUDIA_CONFIG env var
 * 3. ~/.claudia/claudia.json
 */
export function loadConfig(configPath?: string): ClaudiaConfig {
  if (cachedConfig && !configPath) {
    return cachedConfig;
  }

  // Determine config file path
  // Search order: explicit path → env var → ~/.claudia/claudia.json
  const configHome = process.env.CLAUDIA_HOME || homedir();
  const paths = [
    configPath,
    process.env.CLAUDIA_CONFIG,
    join(configHome, ".claudia", "claudia.json"),
  ].filter(Boolean) as string[];

  let rawConfig: Partial<ClaudiaConfig> | null = null;
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
      `[Config] No config file found. Searched: ${searched}. Copy claudia.example.json to ~/.claudia/claudia.json`,
    );
  }
  console.log(`[Config] Loaded from: ${loadedFrom}`);

  // Interpolate environment variables
  const interpolated = interpolateEnvVars(rawConfig) as Partial<ClaudiaConfig>;

  // Merge with defaults
  const config: ClaudiaConfig = {
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
