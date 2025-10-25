/**
 * Parse memory files and extract frontmatter metadata
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import type { ParsedMemory, MemoryFrontmatter } from './types.js';

/**
 * Parse a memory file and extract frontmatter + content
 */
export function parseMemoryFile(filepath: string, memoryRoot: string): ParsedMemory {
  const fullPath = path.isAbsolute(filepath) ? filepath : path.join(memoryRoot, filepath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Memory file not found: ${fullPath}`);
  }

  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  const parsed = matter(fileContent, {
    // Don't convert dates to Date objects - keep as strings!
    engines: {
      yaml: (str) => yaml.load(str, { schema: yaml.JSON_SCHEMA }) as any
    }
  });

  // Validate required frontmatter fields
  const frontmatter = parsed.data as Partial<MemoryFrontmatter>;

  if (!frontmatter.title) {
    throw new Error(`Missing required field 'title' in ${filepath}`);
  }
  if (!frontmatter.date) {
    throw new Error(`Missing required field 'date' in ${filepath}`);
  }
  if (!frontmatter.categories || !Array.isArray(frontmatter.categories)) {
    throw new Error(`Missing or invalid 'categories' in ${filepath}`);
  }
  if (!frontmatter.created_at) {
    throw new Error(`Missing required field 'created_at' in ${filepath}`);
  }
  if (!frontmatter.updated_at) {
    throw new Error(`Missing required field 'updated_at' in ${filepath}`);
  }

  // Get relative filename from memory root
  const relativeFilename = path.relative(memoryRoot, fullPath);

  return {
    filename: relativeFilename,
    frontmatter: frontmatter as MemoryFrontmatter,
    content: fileContent, // Full file including frontmatter
    rawContent: parsed.content // Content without frontmatter
  };
}

/**
 * Parse all memory files in a directory recursively
 */
export function parseMemoryDirectory(memoryRoot: string): ParsedMemory[] {
  const results: ParsedMemory[] = [];

  function scanDirectory(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          scanDirectory(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        // Parse memory files (skip index.md since it's auto-generated)
        try {
          const parsed = parseMemoryFile(fullPath, memoryRoot);
          results.push(parsed);
        } catch (error) {
          console.warn(`Warning: Failed to parse ${fullPath}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  scanDirectory(memoryRoot);
  return results;
}
