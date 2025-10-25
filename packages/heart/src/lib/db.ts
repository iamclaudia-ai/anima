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

  close(): void {
    this.db.close();
  }
}
