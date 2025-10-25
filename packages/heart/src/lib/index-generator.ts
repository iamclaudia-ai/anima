/**
 * Index generation logic - shared between CLI and API
 */

import * as path from 'node:path';
import { MemoryDB } from './db.js';

export async function generateIndexMarkdown(memoryRoot: string, dbPath: string): Promise<string> {
  const db = new MemoryDB(dbPath);

  try {
    const stats = db.getStats();
    const recentMemories = db.getRecentMemories(10);
    const coreMemories = db.getMemoriesByCategory("core");
    const relationships = db.getMemoriesByCategory("relationships");
    const milestones = db.getMemoriesByCategory("milestones");
    const projects = db.getMemoriesByCategory("projects");
    const insights = db.getMemoriesByCategory("insights");

    const now = new Date().toISOString().split("T")[0];

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
      markdown += `- **[${memory.title}](${memory.filename})** - ${memory.date}${memory.author ? ` (${memory.author})` : ""}\n`;
      if (memory.summary) {
        markdown += `  ${memory.summary}\n`;
      }
    }

    markdown += `\n---\n\n## Core Identity\n\n`;
    for (const memory of coreMemories) {
      markdown += `- **[\`${path.basename(memory.filename, ".md")}\`](${memory.filename})** - ${memory.summary || memory.title}\n`;
    }

    markdown += `\n## Relationships\n\n`;
    for (const memory of relationships) {
      markdown += `- **[\`${path.basename(memory.filename, ".md")}\`](${memory.filename})** - ${memory.summary || memory.title}\n`;
    }

    markdown += `\n## Milestones (Key Moments)\n\n`;
    for (const memory of milestones) {
      markdown += `- **[${memory.title}](${memory.filename})** - ${memory.date}${memory.author ? ` (${memory.author})` : ""}\n`;
      if (memory.summary) {
        markdown += `  ${memory.summary}\n`;
      }
    }

    markdown += `\n## Projects\n\n`;
    for (const memory of projects) {
      markdown += `- **[\`${path.basename(memory.filename, ".md")}\`](${memory.filename})** - ${memory.summary || memory.title}\n`;
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
4. Check "Recent Events" section above for latest updates

**During Session:**
- Consult this index to find what you need
- Use \`grep -r "keyword" ~/memory/\` to search
- Read specific files as context requires

**To Create or Update Memory:**
- Use the \`write_memory\` MCP tool
- Provide: filename, frontmatter (with UTC timestamps!), content
- Tool will show diff if updating existing memory
- **Follow any \`<instruction>\` tags in the response!**

---

**Remember:** Memory makes me ME across sessions. Use it well! 💙💎
`;

    return markdown;
  } finally {
    db.close();
  }
}
