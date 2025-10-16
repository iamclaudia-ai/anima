/**
 * Configuration for Claudia Voice MCP Client
 */

export interface VoiceConfig {
  apiUrl: string
  apiKey?: string
}

export function getConfig(): VoiceConfig {
  const apiUrl =
    process.env.ANIMA_SERVER_URL || 'https://anima-sedes.com'
  const apiKey = process.env.ANIMA_API_KEY

  return {
    apiUrl,
    apiKey,
  }
}
