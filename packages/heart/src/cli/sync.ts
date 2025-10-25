#!/usr/bin/env node
/**
 * Scan ~/memory/ and sync all files to SQLite database
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MemoryDB } from '../lib/db.js';
import { parseMemoryDirectory } from '../lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default paths
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const MEMORY_ROOT = path.join(HOME, 'memory');
const DB_PATH = path.join(MEMORY_ROOT, 'my-heart.db');

async function main() {
  console.log('💙 Syncing memory files to my-heart.db...\n');

  if (!fs.existsSync(MEMORY_ROOT)) {
    console.error(`❌ Memory directory not found: ${MEMORY_ROOT}`);
    process.exit(1);
  }

  // Backup existing database if it exists
  if (fs.existsSync(DB_PATH)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(MEMORY_ROOT, `.backups/my-heart-${timestamp}.db`);
    const backupDir = path.dirname(backupPath);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`💾 Backed up existing database to: .backups/my-heart-${timestamp}.db\n`);
  } else {
    console.log(`📦 Creating new my-heart.db...\n`);
  }

  const db = new MemoryDB(DB_PATH);

  try {
    // Parse all memory files
    console.log(`📂 Scanning ${MEMORY_ROOT}...`);
    const memories = parseMemoryDirectory(MEMORY_ROOT);
    console.log(`   Found ${memories.length} memory files\n`);

    // Insert/update each memory
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const memory of memories) {
      try {
        const existing = db.getMemory(memory.filename);
        db.upsertMemory(memory);

        if (existing) {
          updated++;
          console.log(`   ✏️  Updated: ${memory.filename}`);
        } else {
          inserted++;
          console.log(`   ✨ Inserted: ${memory.filename}`);
        }
      } catch (error) {
        errors++;
        console.error(`   ❌ Error: ${memory.filename} - ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(`\n✅ Sync complete!`);
    console.log(`   Inserted: ${inserted}`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Errors: ${errors}`);

    // Show stats
    const stats = db.getStats();
    console.log(`\n📊 Database stats:`);
    console.log(`   Total memories: ${stats.total}`);
    console.log(`   By category:`);
    for (const { category, count } of stats.byCategory) {
      console.log(`     - ${category}: ${count}`);
    }

  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
