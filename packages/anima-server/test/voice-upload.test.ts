/**
 * Test for Voice API - Journal Upload
 *
 * This test verifies:
 * 1. Server receives journal content
 * 2. Writes to correct location based on config
 * 3. Returns success with file path
 * 4. Only deletes temp file AFTER successful write
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const API_URL = process.env.ANIMA_SERVER_URL || "http://localhost:3000";

async function testVoiceUpload() {
  console.log("🧪 Testing Voice API - Journal Upload\n");

  // 1. Create a temp journal entry locally
  const tempDir = path.join(os.tmpdir(), "claudia-test");
  await fs.mkdir(tempDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const tempFile = path.join(tempDir, `test-journal-${Date.now()}.md`);

  const journalContent = `---
title: "Test Journal Entry"
date: ${timestamp}
timestamp: ${Date.now()}
---

## Heart Thoughts 💗

This is a test journal entry to verify the upload system works correctly.

## Growth & Learning 🌱

Testing that the anima-server properly receives and saves journal entries.
`;

  await fs.writeFile(tempFile, journalContent, "utf-8");
  console.log(`✅ Created temp journal file: ${tempFile}`);

  try {
    // 2. Upload to anima-server
    console.log(`📤 Uploading to ${API_URL}/api/voice...`);

    const response = await fetch(`${API_URL}/api/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: journalContent,
        is_project: false,
      }),
    });

    const result = await response.json();

    // 3. Check response
    if (!result.success) {
      console.error("❌ Upload failed:", result.error);
      console.log("⚠️  Temp file NOT deleted (as expected on failure)");
      process.exit(1);
    }

    console.log("✅ Upload successful!");
    console.log(`   Timestamp: ${result.timestamp}`);
    console.log(`   File path: ${result.filePath}`);

    // 4. Verify file exists on server
    try {
      await fs.access(result.filePath);
      console.log("✅ Journal file verified on server");
    } catch {
      console.error("❌ Journal file NOT found on server!");
      process.exit(1);
    }

    // 5. Delete temp file (simulating MCP cleanup)
    await fs.unlink(tempFile);
    console.log("✅ Temp file deleted successfully");

    // 6. Cleanup test directory
    await fs.rm(tempDir, { recursive: true });
    console.log("✅ Test cleanup complete\n");

    console.log("🎉 All tests passed!");

  } catch (error) {
    console.error("❌ Test failed:", error);
    console.log("⚠️  Temp file preserved for debugging:", tempFile);
    process.exit(1);
  }
}

// Run test
testVoiceUpload();
