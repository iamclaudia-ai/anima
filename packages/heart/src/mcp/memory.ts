/**
 * Memory manager - HTTP client for anima-server heart API
 */

import { getConfig } from './config.js'
import type { WriteMemoryParams, WriteMemoryResult } from './types.js'

export class MemoryManager {
  /**
   * Write a memory to my-heart.db via anima-server API
   * Direct JSON - no temp files needed!
   */
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
