import { defineEventHandler, readBody, getHeader } from "h3";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../../../config";
import { MemoryDB, generateIndexMarkdown } from "@claudia/heart";
import type { MemoryFrontmatter, ParsedMemory } from "@claudia/heart";
import { execSync } from "node:child_process";

const execFileAsync = promisify(execFile);

interface RememberRequest {
  content: string; // What to remember
}

interface LibbyCategorizationResult {
  filename: string;
  category: "core" | "relationships" | "milestones" | "projects" | "insights";
  title: string;
  summary: string;
  tags: string[];
  section: string;
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
    const body = await readBody<RememberRequest>(event);

    if (!body || !body.content) {
      return {
        success: false,
        error: "Missing required field: content",
      };
    }

    const { content } = body;

    // Call Libby to categorize
    const categorization = await callLibby(content);

    // Build paths
    const HOME = process.env.HOME || "/Users/claudia";
    const MEMORY_ROOT = path.join(HOME, "memory");
    const DB_PATH = path.join(MEMORY_ROOT, "my-heart.db");
    const filePath = path.join(MEMORY_ROOT, categorization.filename);

    // Check if file exists
    let existingContent = "";
    let fileExists = false;
    try {
      const existing = await fs.readFile(filePath, "utf-8");
      fileExists = true;
      // Strip frontmatter from existing content
      existingContent = stripFrontmatter(existing);
    } catch (error) {
      // File doesn't exist, that's okay
      fileExists = false;
    }

    // Build the new section content
    const newSection = `## ${categorization.section}\n\n${content}`;

    // Build final content (append if file exists)
    const finalContent = fileExists
      ? `${existingContent}\n\n${newSection}`
      : newSection;

    // Build frontmatter
    const now = new Date().toISOString();
    const frontmatter: MemoryFrontmatter = {
      title: categorization.title,
      date: new Date().toISOString().split("T")[0], // YYYY-MM-DD
      categories: [categorization.category],
      tags: categorization.tags,
      summary: categorization.summary,
      created_at: now,
      updated_at: now,
    };

    // Build full markdown with frontmatter
    const yamlFrontmatter = buildFrontmatter(frontmatter);
    const contentWithNewline = finalContent.endsWith("\n")
      ? finalContent
      : finalContent + "\n";
    const fullContent = `---\n${yamlFrontmatter}---\n\n${contentWithNewline}`;

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write the file
    await fs.writeFile(filePath, fullContent, "utf-8");

    // Update database
    const db = new MemoryDB(DB_PATH);

    try {
      // Check if memory already exists in DB
      const existing = db.getMemory(categorization.filename);

      // If updating existing memory, snapshot to changes table first
      if (existing) {
        db.snapshotToChanges(existing);
      }

      const parsed: ParsedMemory = {
        filename: categorization.filename,
        frontmatter,
        content: fullContent,
        rawContent: finalContent,
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
    try {
      execSync(
        `touch -t ${formatTouchTime(frontmatter.updated_at)} "${filePath}"`
      );
    } catch (error) {
      console.warn("Warning: Could not set filesystem timestamps:", error);
      // Non-fatal - continue
    }

    return {
      success: true,
      filename: categorization.filename,
      category: categorization.category,
      tags: categorization.tags,
      section: categorization.section,
    };
  } catch (error) {
    console.error("Error remembering:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
});

/**
 * Call Libby's categorization script
 */
async function callLibby(
  content: string
): Promise<LibbyCategorizationResult> {
  // In Nuxt, we need to use process.cwd() to get to the project root
  const projectRoot = process.cwd();
  const scriptPath = path.join(projectRoot, "libby/libby-categorize.sh");

  try {
    const { stdout } = await execFileAsync(scriptPath, [content]);
    const result = JSON.parse(stdout.trim()) as LibbyCategorizationResult;
    return result;
  } catch (error) {
    throw new Error(
      `Libby categorization failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Strip frontmatter from markdown content
 */
function stripFrontmatter(content: string): string {
  // Match frontmatter between --- delimiters
  const frontmatterRegex = /^---\n[\s\S]*?\n---\n\n/;
  return content.replace(frontmatterRegex, "");
}

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
