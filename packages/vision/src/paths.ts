import * as path from 'node:path'
import * as os from 'node:os'
import type { VisionPaths } from './types'

export function resolveVisionPaths(): VisionPaths {
  const homeDir = os.homedir()
  const visionDir = path.join(homeDir, '.claudia', 'vision')

  return {
    visionDir,
  }
}

export function getImagePath(visionDir: string, timestamp: Date, format: string): string {
  // Format: YYYY-MM-DD/HH-MM-SS-microseconds.{format}
  const date = timestamp.toISOString().split('T')[0]
  const time = timestamp.toISOString().split('T')[1]
  const [hours, minutes, seconds] = time.split(':')
  const [secs, ms] = seconds.split('.')
  const filename = `${hours}-${minutes}-${secs}-${ms.slice(0, 6)}.${format}`

  return path.join(visionDir, date, filename)
}
