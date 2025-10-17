import * as fs from 'node:fs/promises'
import type { JournalEntry, JournalThoughts } from './types'
import { getConfig } from './config'

export class JournalManager {
  /**
   * Upload journal entry from a temporary file.
   * PRIVACY-PRESERVING WORKFLOW:
   * 1. Read thoughts from temp file (path provided by user)
   * 2. Format entry and upload to anima-server via HTTP
   * 3. Delete temp file only after successful upload
   * 4. Return server's response with actual file path
   */
  async uploadFromFile(filepath: string): Promise<JournalEntry> {
    // Step 1: Read and parse the temp file
    const fileContents = await fs.readFile(filepath, 'utf-8')
    const thoughts: JournalThoughts = JSON.parse(fileContents)

    const timestamp = new Date()
    const categories = Object.keys(thoughts).filter(
      (key) => thoughts[key as keyof JournalThoughts] !== undefined,
    )

    if (categories.length === 0) {
      throw new Error('At least one journal category must be provided')
    }

    // Determine if this is project-specific or global
    // project_notes goes to project journal, everything else goes to global
    const isProject = thoughts.project_notes !== undefined

    const content = this.formatEntry(timestamp, thoughts)

    try {
      // Step 2: Upload to anima-server
      const config = getConfig()
      const response = await fetch(`${config.apiUrl}/api/voice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify({
          content,
          is_project: isProject,
        }),
      })

      const result = (await response.json()) as {
        success: boolean
        error?: string
        timestamp: string
        filePath: string
      }

      if (!result.success) {
        throw new Error(result.error || 'Upload failed')
      }

      // Step 3: Delete temp file after success
      await fs.unlink(filepath)

      // Step 4: Return server's response
      return {
        timestamp: new Date(result.timestamp),
        filePath: result.filePath,
        categories,
      }
    } catch (error) {
      // Preserve temp file on error for debugging
      console.error(`Journal upload failed. Temp file preserved at: ${filepath}`)
      throw error
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
