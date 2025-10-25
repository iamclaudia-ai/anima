#!/usr/bin/env node
/**
 * Generate index.md from SQLite database
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateIndexMarkdown } from '../lib/index-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const MEMORY_ROOT = path.join(HOME, 'memory');
const DB_PATH = path.join(MEMORY_ROOT, 'my-heart.db');
const INDEX_PATH = path.join(MEMORY_ROOT, 'index.md');

async function generateIndex() {
  console.log('📖 Generating index.md from database...\n');

  try {
    const markdown = await generateIndexMarkdown(MEMORY_ROOT, DB_PATH);
    fs.writeFileSync(INDEX_PATH, markdown, 'utf-8');

    // Get stats for output
    const { MemoryDB } = await import('../lib/db.js');
    const db = new MemoryDB(DB_PATH);
    const stats = db.getStats();
    db.close();

    console.log(`✅ Generated ${INDEX_PATH}`);
    console.log(`   Total memories indexed: ${stats.total}\n`);
  } catch (error) {
    console.error('❌ Error generating index:', error);
    throw error;
  }
}

generateIndex();
