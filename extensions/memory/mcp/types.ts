/**
 * Types for the Memory MCP Server
 */

export interface MemoryFrontmatter {
  title: string;
  date: string;
  categories: string[];
  tags?: string[];
  author?: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}

export interface ParsedMemory {
  filename: string;
  frontmatter: MemoryFrontmatter;
  content: string;
  sections: MemorySection[];
}

export interface MemorySection {
  title: string;
  content: string;
  level: number; // h2 = 2, h3 = 3, etc.
}

export interface SectionRecord {
  id?: number;
  file_path: string;
  section_title: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface RememberParams {
  content: string;
  filename?: string;
  section?: string;
  tags?: string[];
  category?: string;
}

export interface RecallParams {
  query: string;
  limit?: number;
  category?: string;
}

export interface ReadParams {
  filepath: string;
  section?: string;
}

export interface ListParams {
  category?: string;
  recent?: number;
}

// Memory categories matching existing structure
const MEMORY_CATEGORIES = [
  "core",
  "relationships",
  "milestones",
  "projects",
  "insights",
  "events",
  "personas",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
