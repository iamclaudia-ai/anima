/**
 * SQLite database operations for memory system
 */

import Database from 'better-sqlite3';
import path from 'path';
import type { MemoryRecord, ParsedMemory } from './types.js';

export class MemoryDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Insert or update a memory record
   */
  upsertMemory(parsed: ParsedMemory): void {
    const { filename, frontmatter, content } = parsed;

    const record: Omit<MemoryRecord, 'id'> = {
      filename,
      title: frontmatter.title,
      date: frontmatter.date,
      categories: JSON.stringify(frontmatter.categories),
      tags: frontmatter.tags ? JSON.stringify(frontmatter.tags) : null,
      author: frontmatter.author || null,
      summary: frontmatter.summary || null,
      content, // Full markdown including frontmatter
      created_at: frontmatter.created_at,
      updated_at: frontmatter.updated_at
    };

    const stmt = this.db.prepare(`
      INSERT INTO memories (
        filename, title, date, categories, tags, author, summary, content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(filename) DO UPDATE SET
        title = excluded.title,
        date = excluded.date,
        categories = excluded.categories,
        tags = excluded.tags,
        author = excluded.author,
        summary = excluded.summary,
        content = excluded.content,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.filename,
      record.title,
      record.date,
      record.categories,
      record.tags,
      record.author,
      record.summary,
      record.content,
      record.created_at,
      record.updated_at
    );
  }

  /**
   * Get all memories ordered by date
   */
  getAllMemories(orderBy: 'date' | 'updated_at' = 'date'): MemoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      ORDER BY ${orderBy} DESC
    `);

    return stmt.all() as MemoryRecord[];
  }

  /**
   * Get memories by category
   */
  getMemoriesByCategory(category: string): MemoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE categories LIKE ?
      ORDER BY date DESC
    `);

    return stmt.all(`%"${category}"%`) as MemoryRecord[];
  }

  /**
   * Get recent memories (last N days or entries)
   */
  getRecentMemories(limit: number = 10): MemoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    return stmt.all(limit) as MemoryRecord[];
  }

  /**
   * Search memories by tag
   */
  getMemoriesByTag(tag: string): MemoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE tags LIKE ?
      ORDER BY date DESC
    `);

    return stmt.all(`%"${tag}"%`) as MemoryRecord[];
  }

  /**
   * Get single memory by filename
   */
  getMemory(filename: string): MemoryRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE filename = ?
    `);

    return (stmt.get(filename) as MemoryRecord) || null;
  }

  /**
   * Delete a memory
   */
  deleteMemory(filename: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM memories
      WHERE filename = ?
    `);

    stmt.run(filename);
  }

  /**
   * Snapshot current memory to changes table before update
   */
  snapshotToChanges(memory: MemoryRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO changes (
        memory_id, filename, title, date, categories, tags, author, summary, content,
        created_at, updated_at, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const changedAt = new Date().toISOString();

    stmt.run(
      memory.id,
      memory.filename,
      memory.title,
      memory.date,
      memory.categories,
      memory.tags,
      memory.author,
      memory.summary,
      memory.content,
      memory.created_at,
      memory.updated_at,
      changedAt
    );
  }

  /**
   * Get version history for a memory
   */
  getVersionHistory(filename: string): Array<any> {
    const stmt = this.db.prepare(`
      SELECT * FROM changes
      WHERE filename = ?
      ORDER BY changed_at DESC
    `);

    return stmt.all(filename);
  }

  /**
   * Get statistics
   */
  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    const byCategory = this.db.prepare(`
      SELECT categories, COUNT(*) as count
      FROM memories
      GROUP BY categories
    `).all() as Array<{ categories: string; count: number }>;

    return {
      total: total.count,
      byCategory: byCategory.map(row => ({
        category: JSON.parse(row.categories)[0], // First category
        count: row.count
      }))
    };
  }

  /**
   * Upsert a section record
   */
  upsertSection(filePath: string, sectionTitle: string, summary: string | null = null, folder: string | null | undefined = null): void {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO sections (file_path, section_title, summary, folder, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, section_title) DO UPDATE SET
        summary = excluded.summary,
        folder = excluded.folder,
        updated_at = excluded.updated_at
    `);

    stmt.run(filePath, sectionTitle, summary, folder ?? null, now, now);
  }

  /**
   * Get all sections across all files
   * For project sections, filters by folder (cwd) if provided
   * Returns: { file_path, section_title, summary }[]
   */
  getAllSections(cwd?: string): Array<{ file_path: string; section_title: string; summary: string | null }> {
    let query = `
      SELECT file_path, section_title, summary
      FROM sections
      WHERE 1=1
    `;

    const params: string[] = [];

    if (cwd) {
      // Include all non-project sections (folder IS NULL)
      // AND project sections that match the current folder
      query += ` AND (folder IS NULL OR folder = ?)`;
      params.push(cwd);
    }

    query += ` ORDER BY file_path, section_title`;

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Array<{ file_path: string; section_title: string; summary: string | null }>;
  }

  /**
   * Get sections for a specific file
   */
  getSectionsForFile(filePath: string): Array<{ section_title: string; summary: string | null }> {
    const stmt = this.db.prepare(`
      SELECT section_title, summary
      FROM sections
      WHERE file_path = ?
      ORDER BY section_title
    `);

    return stmt.all(filePath) as Array<{ section_title: string; summary: string | null }>;
  }

  /**
   * Log a remember request and response for debugging
   */
  logRequest(request: string, response: string, success: boolean, error: string | null = null, gitCommit: string | null = null): void {
    const timestamp = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO request_log (timestamp, request, response, success, error, git_commit)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(timestamp, request, response, success ? 1 : 0, error, gitCommit);
  }

  close(): void {
    this.db.close();
  }
}
