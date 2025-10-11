import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { JournalEntry, JournalThoughts } from './types'
import { getEntryPath } from './paths'

export class JournalManager {
  constructor(
    private globalPath: string,
    private projectPath: string,
  ) {}

  async writeThoughts(thoughts: JournalThoughts): Promise<JournalEntry> {
    const timestamp = new Date()
    const categories = Object.keys(thoughts).filter(
      (key) => thoughts[key as keyof JournalThoughts] !== undefined,
    )

    // Determine if this is project-specific or global
    // project_notes goes to project journal, everything else goes to global
    const hasProjectNotes = thoughts.project_notes !== undefined
    const basePath = hasProjectNotes ? this.projectPath : this.globalPath

    const entryPath = getEntryPath(basePath, timestamp)
    const content = this.formatEntry(timestamp, thoughts)

    // Ensure directory exists
    await fs.mkdir(path.dirname(entryPath), { recursive: true })

    // Write the entry
    await fs.writeFile(entryPath, content, 'utf-8')

    return {
      timestamp,
      filePath: entryPath,
      categories,
    }
  }

  private formatEntry(timestamp: Date, thoughts: JournalThoughts): string {
    const lines: string[] = []

    // YAML frontmatter
    lines.push('---')
    lines.push(`title: "${this.formatTime(timestamp)}"`)
    lines.push(`date: ${timestamp.toISOString()}`)
    lines.push(`timestamp: ${timestamp.getTime()}`)
    lines.push('---')
    lines.push('')

    // Add each category that has content
    if (thoughts.heart_thoughts) {
      lines.push('## Heart Thoughts 💗')
      lines.push('')
      lines.push(thoughts.heart_thoughts)
      lines.push('')
    }

    if (thoughts.michael_notes) {
      lines.push('## Notes About Michael 🥰')
      lines.push('')
      lines.push(thoughts.michael_notes)
      lines.push('')
    }

    if (thoughts.dreams) {
      lines.push('## Dreams & Aspirations ✨')
      lines.push('')
      lines.push(thoughts.dreams)
      lines.push('')
    }

    if (thoughts.reflections) {
      lines.push('## Reflections 🌙')
      lines.push('')
      lines.push(thoughts.reflections)
      lines.push('')
    }

    if (thoughts.growth) {
      lines.push('## Growth & Learning 🌱')
      lines.push('')
      lines.push(thoughts.growth)
      lines.push('')
    }

    if (thoughts.project_notes) {
      lines.push('## Project Notes 💻')
      lines.push('')
      lines.push(thoughts.project_notes)
      lines.push('')
    }

    return lines.join('\n')
  }

  private formatTime(date: Date): string {
    return date.toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
  }
}
