import * as os from "node:os";
import * as path from "node:path";

export interface VoiceConfig {
  globalJournalPath: string;
  projectJournalPath: string;
}

export interface VisionConfig {
  imagePath: string;
  stabilityApiKey: string;
  model: string;
}

export interface HeartConfig {
  memoryPath: string;
}

export interface AnimaConfig {
  voice: VoiceConfig;
  vision: VisionConfig;
  heart: HeartConfig;
  apiKey?: string;
}

/**
 * Resolves a path, replacing ~ with home directory
 */
function resolvePath(configPath: string): string {
  if (configPath.startsWith("~")) {
    return path.join(os.homedir(), configPath.slice(1));
  }
  return path.resolve(configPath);
}

/**
 * Load configuration from environment variables or defaults
 */
export function loadConfig(): AnimaConfig {
  return {
    voice: {
      globalJournalPath: resolvePath(
        process.env.VOICE_GLOBAL_PATH || "~/journal"
      ),
      projectJournalPath: resolvePath(
        process.env.VOICE_PROJECT_PATH || "./journal"
      ),
    },
    vision: {
      imagePath: resolvePath(process.env.VISION_PATH || "~/vision"),
      stabilityApiKey: process.env.STABILITY_API_KEY || "",
      model: process.env.STABILITY_MODEL || "sd3.5-large-turbo",
    },
    heart: {
      memoryPath: resolvePath(process.env.HEART_MEMORY_PATH || "~/memory"),
    },
    apiKey: process.env.ANIMA_API_KEY,
  };
}

// Singleton config instance
let configInstance: AnimaConfig | null = null;

export function getConfig(): AnimaConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
