/**
 * Types for Heart MCP tool parameters
 */

import type { MemoryFrontmatter } from '../lib/types.js'

export interface WriteMemoryParams {
  filename: string // Relative path from ~/memory/
  frontmatter: MemoryFrontmatter
  content: string // Content WITHOUT frontmatter
}

export interface WriteMemoryResult {
  success: boolean
  filename: string
  updated_at: string
  error?: string
}
