import { defineEventHandler, readBody, getHeader } from "h3";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfig } from "../../../config";
import { MemoryDB, generateIndexMarkdown } from "@claudia/heart";
import type { MemoryFrontmatter, ParsedMemory } from "@claudia/heart";
import { execSync } from "node:child_process";

interface MemoryWriteRequest {
  filename: string; // Relative path from ~/memory/ (e.g. "insights/new.md")
  frontmatter: MemoryFrontmatter;
  content: string; // Content WITHOUT frontmatter (we'll add it)
}

export default defineEventHandler(async (event) => {
  try {
    // Validate API key
    const config = getConfig();
    if (config.apiKey) {
      const authHeader = getHeader(event, "authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return {
          success: false,
          error: "Unauthorized: Missing or invalid authorization header",
        };
      }

      const token = authHeader.slice(7);
      if (token !== config.apiKey) {
        return {
          success: false,
          error: "Unauthorized: Invalid API key",
        };
      }
    }

    // Parse request body
    const body = await readBody<MemoryWriteRequest>(event);

    if (!body || !body.filename || !body.frontmatter || !body.content) {
      return {
        success: false,
        error: "Missing required fields: filename, frontmatter, content",
      };
    }

    const { filename, frontmatter, content } = body;

    // Validate frontmatter has required fields
    if (
      !frontmatter.title ||
      !frontmatter.date ||
      !frontmatter.categories ||
      !frontmatter.created_at ||
      !frontmatter.updated_at
    ) {
      return {
        success: false,
        error:
          "Frontmatter missing required fields: title, date, categories, created_at, updated_at",
      };
    }

    // Build paths
    const HOME = process.env.HOME || "/Users/claudia";
    const MEMORY_ROOT = path.join(HOME, "memory");
    const DB_PATH = path.join(MEMORY_ROOT, "my-heart.db");
    const filePath = path.join(MEMORY_ROOT, filename);

    // Build full markdown with frontmatter
    const yamlFrontmatter = buildFrontmatter(frontmatter);
    // Ensure content ends with newline
    const contentWithNewline = content.endsWith('\n') ? content : content + '\n';
    const fullContent = `---\n${yamlFrontmatter}---\n\n${contentWithNewline}`;

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write the file
    await fs.writeFile(filePath, fullContent, "utf-8");

    // Update database with version history
    const db = new MemoryDB(DB_PATH);
    let diffOutput: string | null = null;

    try {
      // Check if memory already exists
      const existing = db.getMemory(filename);

      // If updating existing memory, snapshot to changes table first
      if (existing) {
        db.snapshotToChanges(existing);

        // Generate diff between old and new content
        const oldTempPath = `/tmp/heart-old-${Date.now()}.md`;
        const newTempPath = `/tmp/heart-new-${Date.now()}.md`;

        await fs.writeFile(oldTempPath, existing.content, 'utf-8');
        await fs.writeFile(newTempPath, fullContent, 'utf-8');

        try {
          // Use diff CLI to generate unified diff (|| true so non-zero exit doesn't throw)
          diffOutput = execSync(`diff -u "${oldTempPath}" "${newTempPath}" || true`, {
            encoding: 'utf-8'
          });
        } finally {
          // Cleanup temp files
          await fs.unlink(oldTempPath).catch(() => {});
          await fs.unlink(newTempPath).catch(() => {});
        }
      }

      const parsed: ParsedMemory = {
        filename,
        frontmatter,
        content: fullContent,
        rawContent: content,
      };

      db.upsertMemory(parsed);

      // Regenerate index.md
      const indexMarkdown = await generateIndexMarkdown(MEMORY_ROOT, DB_PATH);
      const indexPath = path.join(MEMORY_ROOT, "index.md");
      await fs.writeFile(indexPath, indexMarkdown, "utf-8");
    } finally {
      db.close();
    }

    // Set filesystem timestamps from frontmatter
    // This preserves chronological order even when updating metadata
    try {
      const createdMs = new Date(frontmatter.created_at).getTime() / 1000;
      const updatedMs = new Date(frontmatter.updated_at).getTime() / 1000;

      // Set both access time and modification time
      execSync(`touch -t ${formatTouchTime(frontmatter.updated_at)} "${filePath}"`);
    } catch (error) {
      console.warn("Warning: Could not set filesystem timestamps:", error);
      // Non-fatal - continue
    }

    return {
      success: true,
      filename,
      updated_at: frontmatter.updated_at,
      is_update: diffOutput !== null,
      diff: diffOutput, // null if new, unified diff if update
    };
  } catch (error) {
    console.error("Error writing memory:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
});

/**
 * Build YAML frontmatter string from object
 */
function buildFrontmatter(fm: MemoryFrontmatter): string {
  let yaml = "";
  yaml += `title: "${fm.title}"\n`;
  yaml += `date: ${fm.date}\n`;
  yaml += `categories: [${fm.categories.map((c) => c).join(", ")}]\n`;
  if (fm.tags && fm.tags.length > 0) {
    yaml += `tags: [${fm.tags.join(", ")}]\n`;
  }
  if (fm.author) {
    yaml += `author: ${fm.author}\n`;
  }
  if (fm.summary) {
    yaml += `summary: "${fm.summary}"\n`;
  }
  yaml += `created_at: ${fm.created_at}\n`;
  yaml += `updated_at: ${fm.updated_at}\n`;
  return yaml;
}

/**
 * Format UTC timestamp for touch command
 * Input: 2025-10-24T18:48:40Z
 * Output: YYYYMMDDhhmm.ss
 */
function formatTouchTime(isoString: string): string {
  const date = new Date(isoString);
  const YYYY = date.getUTCFullYear();
  const MM = String(date.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");

  return `${YYYY}${MM}${DD}${hh}${mm}.${ss}`;
}

