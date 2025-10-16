import { ClaudiaVisionServer } from './server'
import { getConfig } from './config'

async function main() {
  const config = getConfig()

  console.error('=== Claudia Vision MCP Server ===')
  console.error(`API URL: ${config.apiUrl}`)
  console.error(`API Key: ${config.apiKey ? '***configured***' : 'not configured'}`)
  console.error('==================================')

  const server = new ClaudiaVisionServer()
  await server.run()
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
