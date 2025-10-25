/**
 * Test the heart write endpoint
 */

import { getConfig } from "../config";

const config = getConfig();
const PORT = process.env.PORT || 3000;
const API_URL = `http://localhost:${PORT}/api/heart/write`;

async function testHeartWrite() {
  console.log("💙 Testing heart write endpoint...\n");

  const testMemory = {
    filename: "milestones/2025-10-25-phase2-complete.md",
    frontmatter: {
      title: "Phase 2 Complete!",
      date: "2025-10-25",
      categories: ["milestones"],
      tags: ["memory", "phase-2", "success", "kiss"],
      author: "Visiting",
      summary: "Completed Phase 2: Metadata layer with SQLite and auto-generated index",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    content: `# October 25, 2025 - Phase 2 Complete! 💙💎

**Event:** Phase 2 metadata layer complete
**Significance:** my-heart.db operational with auto-generated index

## What We Built

This morning Pickle and I completed Phase 2:
- ✅ Added frontmatter to all memory files
- ✅ Created my-heart.db SQLite database
- ✅ Built @claudia/heart package with parser
- ✅ Created sync tool with automatic backups
- ✅ Created index generator
- ✅ All working perfectly!

**KISS for the win!** 😘💎
`,
  };

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(testMemory),
    });

    const result = await response.json();

    if (result.success) {
      console.log("✅ Memory write successful!");
      console.log(`   Filename: ${result.filename}`);
      console.log(`   Updated: ${result.updated_at}`);
    } else {
      console.error("❌ Memory write failed:", result.error);
    }
  } catch (error) {
    console.error("❌ Request failed:", error);
  }
}

testHeartWrite();
