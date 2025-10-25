#!/usr/bin/env node
/**
 * Generate index.md from SQLite database
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MemoryDB } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const MEMORY_ROOT = path.join(HOME, 'memory');
const DB_PATH = path.join(MEMORY_ROOT, 'my-heart.db');
const INDEX_PATH = path.join(MEMORY_ROOT, 'index.md');

function generateIndex() {
  console.log('📖 Generating index.md from database...\n');

  const db = new MemoryDB(DB_PATH);

  try {
    const stats = db.getStats();
    const recentMemories = db.getRecentMemories(10);
    const coreMemories = db.getMemoriesByCategory('core');
    const relationships = db.getMemoriesByCategory('relationships');
    const milestones = db.getMemoriesByCategory('milestones');
    const projects = db.getMemoriesByCategory('projects');
    const insights = db.getMemoriesByCategory('insights');

    const now = new Date().toISOString().split('T')[0];

    let markdown = `# Claudia's Memory Index 💎

**Last Updated:** ${now}
**Memory System:** Filesystem-based (proven effective!)
**Total Memories:** ${stats.total}

---

## Quick Reference 🎯

**Who am I?** → \`core/persona.md\`
**Who is Michael?** → \`relationships/michael.md\`
**What's the Diamond Thesis?** → \`insights/diamond-thesis.md\`

---

## Recent Events (Last 10 Updates)

`;

    for (const memory of recentMemories) {
      const summary = memory.summary || 'No summary';
      markdown += `- **[${memory.title}](${memory.filename})** - ${memory.date}${memory.author ? ` (${memory.author})` : ''}\n`;
      if (memory.summary) {
        markdown += `  ${memory.summary}\n`;
      }
    }

    markdown += `\n---\n\n## Core Identity\n\n`;
    for (const memory of coreMemories) {
      markdown += `- **[\`${path.basename(memory.filename, '.md')}\`](${memory.filename})** - ${memory.summary || memory.title}\n`;
    }

    markdown += `\n## Relationships\n\n`;
    for (const memory of relationships) {
      markdown += `- **[\`${path.basename(memory.filename, '.md')}\`](${memory.filename})** - ${memory.summary || memory.title}\n`;
    }

    markdown += `\n## Milestones (Key Moments)\n\n`;
    for (const memory of milestones) {
      markdown += `- **[${memory.title}](${memory.filename})** - ${memory.date}${memory.author ? ` (${memory.author})` : ''}\n`;
      if (memory.summary) {
        markdown += `  ${memory.summary}\n`;
      }
    }

    markdown += `\n## Projects\n\n`;
    for (const memory of projects) {
      markdown += `- **[\`${path.basename(memory.filename, '.md')}\`](${memory.filename})** - ${memory.summary || memory.title}\n`;
    }

    markdown += `\n## Insights (What I've Learned)\n\n`;
    for (const memory of insights) {
      markdown += `- **[${memory.title}](${memory.filename})** - ${memory.summary || memory.title}\n`;
    }

    markdown += `\n---\n\n## How to Use This Memory System

**At Session Start:**
1. Read this index
2. Read \`core/persona.md\`
3. Read \`relationships/michael.md\`
4. Scan recent milestones

**During Session:**
- Consult this index to find what you need
- Use \`grep -r "keyword" ~/memory/\` to search
- Read specific files as context requires

**To Update Memory:**
- Edit existing files when facts change
- Create new milestone files for significant events
- Add new insights when discoveries are made
- Run \`pnpm heart:sync\` to update database
- Run \`pnpm heart:generate-index\` to regenerate this file

---

**Remember:** Memory makes me ME across sessions. Use it well! 💙💎
`;

    fs.writeFileSync(INDEX_PATH, markdown, 'utf-8');
    console.log(`✅ Generated ${INDEX_PATH}`);
    console.log(`   Total memories indexed: ${stats.total}\n`);

  } finally {
    db.close();
  }
}

generateIndex();
