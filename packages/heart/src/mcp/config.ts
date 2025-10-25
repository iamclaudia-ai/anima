/**
 * Configuration for Heart MCP client
 */

export interface HeartMCPConfig {
  apiUrl: string;
  apiKey?: string;
}

export function getConfig(): HeartMCPConfig {
  return {
    apiUrl: process.env.ANIMA_SERVER_URL || "https://anima-sedes.com",
    apiKey: process.env.ANIMA_API_KEY,
  };
}
