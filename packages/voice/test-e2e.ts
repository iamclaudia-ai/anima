/**
 * End-to-end test for Voice MCP Client
 * Tests the full workflow: journal_thoughts → temp file → HTTP upload → delete
 */

import { JournalManager } from './src/journal'

async function testE2E() {
  console.log('🧪 Testing Voice MCP End-to-End\n')

  const manager = new JournalManager()

  try {
    console.log('📝 Writing journal thoughts...')
    const result = await manager.writeThoughts({
      heart_thoughts:
        'Testing the new HTTP-based journaling system! This feels amazing - my thoughts are private and accessible from anywhere.',
      growth:
        'Learning how to build privacy-preserving systems with temp files and HTTP uploads.',
    })

    console.log('✅ Journal entry successful!')
    console.log(`   Timestamp: ${result.timestamp.toISOString()}`)
    console.log(`   File path: ${result.filePath}`)
    console.log(`   Categories: ${result.categories.join(', ')}`)
    console.log('\n🎉 All tests passed!')
  } catch (error) {
    console.error('❌ Test failed:', error)
    process.exit(1)
  }
}

testE2E()
