/**
 * Configuration for Heart MCP client
 */

export interface HeartMCPConfig {
  apiUrl: string;
  apiKey?: string;
  syncCommand?: string; // Optional command to sync memory after writes
}

export function getConfig(): HeartMCPConfig {
  return {
    apiUrl: process.env.ANIMA_SERVER_URL || "https://anima-sedes.com",
    apiKey: process.env.ANIMA_API_KEY,
    syncCommand: process.env.HEART_SYNC_COMMAND, // e.g. "rsync -av ~/memory/ ~/anima-sedes/memory/"
  };
}
