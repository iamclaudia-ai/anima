import { ClaudiaVoiceServer } from './server'
import { getConfig } from './config'

async function main() {
  const config = getConfig()

  console.error('=== Claudia Voice MCP Server ===')
  console.error(`API URL: ${config.apiUrl}`)
  console.error(`API Key: ${config.apiKey ? '***configured***' : 'not configured'}`)
  console.error('================================')

  const server = new ClaudiaVoiceServer()
  await server.run()
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
