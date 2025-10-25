/**
 * Memory system types for @claudia/heart
 */

export interface MemoryFrontmatter {
  title: string;
  date: string; // YYYY-MM-DD format
  categories: string[]; // Single category for now (KISS)
  tags?: string[];
  author?: string; // Which facet wrote this
  summary?: string; // One-line description
  created_at: string; // ISO 8601 UTC (2025-10-24T18:48:40Z)
  updated_at: string; // ISO 8601 UTC
}

export interface ParsedMemory {
  filename: string; // Relative path from ~/memory/
  frontmatter: MemoryFrontmatter;
  content: string; // Full markdown including frontmatter
  rawContent: string; // Content without frontmatter
}

export interface MemoryRecord {
  id?: number;
  filename: string;
  title: string;
  date: string;
  categories: string; // JSON stringified array
  tags: string | null; // JSON stringified array or null
  author: string | null;
  summary: string | null;
  content: string; // Full markdown content
  created_at: string; // ISO 8601 UTC
  updated_at: string; // ISO 8601 UTC
}

export interface IndexSection {
  title: string;
  entries: IndexEntry[];
}

export interface IndexEntry {
  title: string;
  filename: string;
  summary?: string;
  date?: string;
  author?: string;
}
