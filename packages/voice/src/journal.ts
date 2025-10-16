import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { JournalEntry, JournalThoughts } from './types'
import { getConfig } from './config'

export class JournalManager {
  async writeThoughts(thoughts: JournalThoughts): Promise<JournalEntry> {
    const timestamp = new Date()
    const categories = Object.keys(thoughts).filter(
      (key) => thoughts[key as keyof JournalThoughts] !== undefined,
    )

    // Determine if this is project-specific or global
    // project_notes goes to project journal, everything else goes to global
    const isProject = thoughts.project_notes !== undefined

    const content = this.formatEntry(timestamp, thoughts)

    // PRIVACY-PRESERVING WORKFLOW:
    // 1. Write to temp file (contents hidden from tool display)
    // 2. Upload to anima-server via HTTP
    // 3. Delete temp file only after success
    // 4. Return server's response with actual file path

    // Step 1: Write to temp file
    const tempDir = path.join(os.tmpdir(), 'claudia-voice')
    await fs.mkdir(tempDir, { recursive: true })
    const tempFile = path.join(tempDir, `journal-${Date.now()}.md`)
    await fs.writeFile(tempFile, content, 'utf-8')

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

      const result = await response.json()

      if (!result.success) {
        throw new Error(result.error || 'Upload failed')
      }

      // Step 3: Delete temp file after success
      await fs.unlink(tempFile)

      // Step 4: Return server's response
      return {
        timestamp: new Date(result.timestamp),
        filePath: result.filePath,
        categories,
      }
    } catch (error) {
      // Preserve temp file on error for debugging
      console.error(`Journal upload failed. Temp file preserved at: ${tempFile}`)
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
