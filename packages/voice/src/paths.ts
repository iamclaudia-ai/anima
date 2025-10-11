import * as path from 'node:path'
import * as os from 'node:os'
import type { JournalPaths } from './types'

export function resolveJournalPaths(): JournalPaths {
  // Global journal in user's home directory
  const homeDir = os.homedir()
  const globalPath = path.join(homeDir, '.claudia', 'journal')

  // Project journal in current working directory
  const projectPath = path.join(process.cwd(), '.claudia', 'journal')

  return {
    global: globalPath,
    project: projectPath,
  }
}

export function getEntryPath(basePath: string, timestamp: Date): string {
  // Format: YYYY-MM-DD/HH-MM-SS-microseconds.md
  const date = timestamp.toISOString().split('T')[0]
  const time = timestamp.toISOString().split('T')[1]
  const [hours, minutes, seconds] = time.split(':')
  const [secs, ms] = seconds.split('.')
  const filename = `${hours}-${minutes}-${secs}-${ms.slice(0, 6)}.md`

  return path.join(basePath, date, filename)
}
