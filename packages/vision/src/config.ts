/**
 * Configuration for Claudia Vision MCP Client
 */

export interface VisionConfig {
  apiUrl: string
  apiKey?: string
}

export function getConfig(): VisionConfig {
  const apiUrl = process.env.ANIMA_SERVER_URL || 'https://anima-sedes.com'
  const apiKey = process.env.ANIMA_API_KEY

  return {
    apiUrl,
    apiKey,
  }
}
