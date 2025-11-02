/**
 * Memory manager - HTTP client for anima-server heart API
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getConfig } from './config.js'
import type { WriteMemoryParams, WriteMemoryResult, LibbyCategorizationResult, RememberResult } from './types.js'

const execFileAsync = promisify(execFile)

export class MemoryManager {
  /**
   * Write a memory to my-heart.db via anima-server API
   * Direct JSON - no temp files needed!
   */
  /**
   * Remember something with automatic categorization by Libby! 👑
   * Calls libby-categorize.sh to determine how to store the memory
   *
   * IMPORTANT: We check if file exists ourselves - don't trust Libby's action field!
   */
  async remember(content: string): Promise<RememberResult> {
    // Call Libby's categorization script
    const categorization = await this.callLibby(content)

    // Check if file exists by trying to read it from anima-server
    const fileExists = await this.checkFileExists(categorization.filename)

    // Build the memory content with section
    const memoryContent = `## ${categorization.section}\n\n${content}`

    // Get current timestamp
    const now = new Date().toISOString()

    // Build frontmatter
    const frontmatter = {
      title: categorization.title,
      date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
      categories: [categorization.category],
      tags: categorization.tags,
      summary: categorization.summary,
      created_at: now,
      updated_at: now,
    }

    // If file exists, we need to append - read existing content first
    let finalContent = memoryContent
    if (fileExists) {
      const existingContent = await this.readMemoryFile(categorization.filename)
      // Append new section to existing content (after frontmatter is stripped by server)
      finalContent = `${existingContent}\n\n${memoryContent}`
    }

    // Write the memory using existing writeMemory method
    const writeResult = await this.writeMemory({
      filename: categorization.filename,
      frontmatter,
      content: finalContent,
    })

    // Return result with categorization info (use our determination, not Libby's)
    return {
      ...categorization,
      action: fileExists ? 'append' : 'create',
      success: writeResult.success,
    }
  }

  /**
   * Check if a memory file exists on anima-server
   */
  private async checkFileExists(filename: string): Promise<boolean> {
    const config = getConfig()

    try {
      const response = await fetch(`${config.apiUrl}/api/heart/exists?filename=${encodeURIComponent(filename)}`, {
        method: 'GET',
        headers: {
          ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
        },
      })

      if (!response.ok) {
        // If endpoint doesn't exist yet, assume file doesn't exist
        return false
      }

      const result = await response.json() as { exists: boolean }
      return result.exists
    } catch (error) {
      // On error, assume file doesn't exist (safer to create than overwrite)
      return false
    }
  }

  /**
   * Read existing memory file content from anima-server
   */
  private async readMemoryFile(filename: string): Promise<string> {
    const config = getConfig()

    try {
      const response = await fetch(`${config.apiUrl}/api/heart/read?filename=${encodeURIComponent(filename)}`, {
        method: 'GET',
        headers: {
          ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to read file: ${response.statusText}`)
      }

      const result = await response.json() as { content: string }
      return result.content
    } catch (error) {
      throw new Error(
        `Failed to read memory file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  /**
   * Call Libby's categorization script
   */
  private async callLibby(content: string): Promise<LibbyCategorizationResult> {
    // Get the path to libby-categorize.sh
    // We're in packages/heart/src/mcp/memory.ts, need to go up to project root
    const currentFile = fileURLToPath(import.meta.url)
    const currentDir = dirname(currentFile)
    const projectRoot = join(currentDir, '../../../../')
    const scriptPath = join(projectRoot, 'scripts/libby-categorize.sh')

    try {
      const { stdout } = await execFileAsync(scriptPath, [content])
      const result = JSON.parse(stdout.trim()) as LibbyCategorizationResult
      return result
    } catch (error) {
      throw new Error(
        `Libby categorization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  async writeMemory(params: WriteMemoryParams): Promise<WriteMemoryResult> {
    const config = getConfig()

    try {
      const response = await fetch(`${config.apiUrl}/api/heart/write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify(params),
      })

      const result = (await response.json()) as WriteMemoryResult

      if (!result.success) {
        throw new Error(result.error || 'Memory write failed')
      }

      return result
    } catch (error) {
      throw new Error(
        `Failed to write memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }
}
