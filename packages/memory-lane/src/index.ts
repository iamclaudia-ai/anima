import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Paths
const DB_PATH = path.join(os.homedir(), '.local/state/agent-tts/agent-tts.db')
const STATE_DIR = path.join(os.homedir(), '.claudia/memory-lane')
const CHAT_LOGS_DIR = path.join(STATE_DIR, 'chat-logs')
const LAST_ID_FILE = path.join(STATE_DIR, 'last_id.txt')
const CURRENT_PROJECT_FILE = path.join(STATE_DIR, 'current_project.txt')

interface Message {
  id: number
  timestamp: number
  profile: string
  role: string
  original_text: string
  images: string | null
  cwd: string
}

// Ensure state directories exist
fs.mkdirSync(STATE_DIR, { recursive: true })
fs.mkdirSync(CHAT_LOGS_DIR, { recursive: true })

// Get last processed ID
function getLastId(): number {
  if (fs.existsSync(LAST_ID_FILE)) {
    return parseInt(fs.readFileSync(LAST_ID_FILE, 'utf-8').trim(), 10)
  }
  return 0
}

// Save last processed ID
function saveLastId(id: number): void {
  fs.writeFileSync(LAST_ID_FILE, id.toString())
}

// Get current project
function getCurrentProject(): string | null {
  if (fs.existsSync(CURRENT_PROJECT_FILE)) {
    return fs.readFileSync(CURRENT_PROJECT_FILE, 'utf-8').trim()
  }
  return null
}

// Save current project
function saveCurrentProject(cwd: string): void {
  fs.writeFileSync(CURRENT_PROJECT_FILE, cwd)
}

// Convert cwd to safe filename
function cwdToFilename(cwd: string): string {
  return cwd.replace(/\//g, '_').replace(/^_/, '') + '.md'
}

// Get chat log path for project
function getChatLogPath(cwd: string): string {
  return path.join(CHAT_LOGS_DIR, cwdToFilename(cwd))
}

// Format timestamp for display
function formatTimestamp(unixTime: number): string {
  const date = new Date(unixTime * 1000)
  return date.toISOString()
}

// Format message for chat log
function formatMessage(msg: Message): string {
  const timestamp = formatTimestamp(msg.timestamp)
  const role = msg.role === 'assistant' ? '**Claudia**' : '**Michael**'
  let content = `### ${role} (${timestamp})\n\n${msg.original_text}\n\n`

  if (msg.images) {
    const imagePaths = msg.images.split(',').map(img => img.trim())
    content += `*Images: ${imagePaths.join(', ')}*\n\n`
  }

  return content
}

// Main function
async function main() {
  const args = process.argv.slice(2)
  const action = args[0] // --clear or --continue or undefined

  // Open database
  const db = new Database(DB_PATH, { readonly: true })

  try {
    const lastId = getLastId()

    // Get next message (include both 'ara' and 'claudia' profiles for full history)
    const msg = db.prepare(`
      SELECT * FROM tts_queue
      WHERE id > ? AND profile IN ('ara', 'claudia')
      ORDER BY id ASC
      LIMIT 1
    `).get(lastId) as Message | undefined

    if (!msg) {
      console.log('\n🎉 You\'ve reached the end of your memory lane!')
      console.log('You\'re all caught up to the present moment.\n')
      return
    }

    const currentProject = getCurrentProject()
    const chatLogPath = getChatLogPath(msg.cwd)

    // Check if we're in a new project
    if (currentProject !== msg.cwd) {
      console.log(`\n📂 **NEW PROJECT DETECTED**`)
      console.log(`   Path: ${msg.cwd}`)
      console.log(`   Previous: ${currentProject || 'none'}`)
      console.log(`   Starting new chat log: ${cwdToFilename(msg.cwd)}\n`)
      saveCurrentProject(msg.cwd)
    }

    // Handle action
    if (action === '--clear') {
      // Clear chat log and move to next message
      fs.writeFileSync(chatLogPath, '')
      saveLastId(msg.id)
      console.log(`\n✅ Chat log cleared. Ready for next message.\n`)
      console.log(`Run 'memory-lane' to continue.\n`)
      return
    }

    // Append message to chat log
    const formattedMsg = formatMessage(msg)
    fs.appendFileSync(chatLogPath, formattedMsg)

    // Display message
    console.log('\n' + '='.repeat(80))
    console.log(`📍 Message ID: ${msg.id}`)
    console.log(`📂 Project: ${msg.cwd}`)
    console.log(`📝 Chat log: ${cwdToFilename(msg.cwd)}`)
    console.log('='.repeat(80) + '\n')
    console.log(formattedMsg)
    console.log('='.repeat(80))
    console.log('\n💭 **What would you like to do?**')
    console.log('   • Read the full chat log: cat ' + chatLogPath)
    console.log('   • Continue reading: memory-lane')
    console.log('   • Capture & move on: memory-lane --clear')
    console.log('\n')

    // Don't update last_id yet - only on --clear

  } finally {
    db.close()
  }
}

main().catch(console.error)
