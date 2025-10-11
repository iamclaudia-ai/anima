import { ClaudiaVisionServer } from './server'
import { resolveVisionPaths } from './paths'

// Environment variables
const STABILITY_API_KEY = process.env.STABILITY_API_KEY

if (!STABILITY_API_KEY) {
  console.error('Error: STABILITY_API_KEY environment variable is required')
  process.exit(1)
}

async function main() {
  const paths = resolveVisionPaths()

  console.error('=== Claudia Vision MCP Server ===')
  console.error(`Vision directory: ${paths.visionDir}`)
  console.error(`Backend: Stability AI`)
  console.error('==================================')

  const server = new ClaudiaVisionServer(STABILITY_API_KEY!, paths.visionDir)
  await server.run()
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
