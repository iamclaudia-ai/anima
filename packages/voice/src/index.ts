import { ClaudiaVoiceServer } from './server'
import { resolveJournalPaths } from './paths'

async function main() {
  const paths = resolveJournalPaths()

  console.error('=== Claudia Voice MCP Server ===')
  console.error(`Global journal: ${paths.global}`)
  console.error(`Project journal: ${paths.project}`)
  console.error('================================')

  const server = new ClaudiaVoiceServer(paths.global, paths.project)
  await server.run()
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
