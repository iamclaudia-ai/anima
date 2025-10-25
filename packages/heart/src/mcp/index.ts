#!/usr/bin/env node
/**
 * Heart MCP Server Entry Point
 * Thin HTTP client for updating my-heart.db via anima-server
 */

import { ClaudiaHeartServer } from './server.js'
import { getConfig } from './config.js'

async function main() {
  const config = getConfig()

  console.error('=== Claudia Heart MCP Server ===')
  console.error(`API URL: ${config.apiUrl}`)
  console.error(`API Key: ${config.apiKey ? '***configured***' : 'not configured'}`)
  console.error('================================')

  const server = new ClaudiaHeartServer()
  await server.run()
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
