import { defineEventHandler, readBody, getHeader } from "h3";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../../../config";
import { MemoryDB, generateIndexMarkdown } from "@claudia/heart";
import type { MemoryFrontmatter, ParsedMemory } from "@claudia/heart";
import { execSync } from "node:child_process";
import { insertIntoSection, sectionExists, extractSections } from "../../../utils/markdown-section";

const execFileAsync = promisify(execFile);

// Categories that use section-based organization
// (milestones and insights are single-shot memories, don't need sections)
const SECTION_BASED_CATEGORIES = ["core", "relationships", "projects"] as const;

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

    // Build paths
    const HOME = process.env.HOME || "/Users/claudia";
    const MEMORY_ROOT = path.join(HOME, "memory");
    const DB_PATH = path.join(MEMORY_ROOT, "my-heart.db");

    // Get existing sections from database (only section-based categories)
    const tempDb = new MemoryDB(DB_PATH);
    const existingSections = tempDb.getSectionBasedSections();
    tempDb.close();

    // Call Libby to categorize (with existing sections context)
    const categorization = await callLibby(content, existingSections);

    const filePath = path.join(MEMORY_ROOT, categorization.filename);

    // Check if target file exists
    let targetFilePath = filePath;
    let finalContentWithoutFrontmatter: string;
    let existingFrontmatter: MemoryFrontmatter | null = null;

    try {
      const existing = await fs.readFile(filePath, "utf-8");
      const existingWithoutFrontmatter = stripFrontmatter(existing);

      // Extract existing frontmatter to preserve created_at
      const frontmatterMatch = existing.match(/^---\n([\s\S]*?)\n---\n\n/);
      if (frontmatterMatch) {
        const yamlContent = frontmatterMatch[1];
        const createdAtMatch = yamlContent.match(/created_at:\s*(.+)/);
        if (createdAtMatch) {
          existingFrontmatter = { created_at: createdAtMatch[1].trim() } as any;
        }
      }

      // Check if section exists in the file
      if (sectionExists(existingWithoutFrontmatter, categorization.section)) {
        // Section exists - append to existing section
        const insertResult = await insertIntoSection(
          existingWithoutFrontmatter,
          categorization.section,
          content
        );
        finalContentWithoutFrontmatter = insertResult.markdown;
        // Keep existing file path
      } else {
        // Section doesn't exist - create new section file
        const baseName = path.basename(filePath, ".md");
        const sectionSlug = categorization.section
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        const sectionFileName = `${baseName}-${sectionSlug}.md`;
        targetFilePath = path.join(path.dirname(filePath), sectionFileName);

        // Create new file with just this section
        finalContentWithoutFrontmatter = `## ${categorization.section}\n\n${content}`;
        // New file, so no existing frontmatter to preserve
        existingFrontmatter = null;
      }
    } catch (error) {
      // File doesn't exist - create it with the section
      finalContentWithoutFrontmatter = `## ${categorization.section}\n\n${content}`;
    }

    // Build frontmatter (preserve created_at from existing file)
    const now = new Date().toISOString();
    const frontmatter: MemoryFrontmatter = {
      title: categorization.title,
      date: new Date().toISOString().split("T")[0], // YYYY-MM-DD
      categories: [categorization.category],
      tags: categorization.tags,
      summary: categorization.summary,
      created_at: existingFrontmatter?.created_at || now,
      updated_at: now,
    };

    // Build full markdown with frontmatter
    const yamlFrontmatter = buildFrontmatter(frontmatter);
    const contentWithNewline = finalContentWithoutFrontmatter.endsWith("\n")
      ? finalContentWithoutFrontmatter
      : finalContentWithoutFrontmatter + "\n";
    const fullContent = `---\n${yamlFrontmatter}---\n\n${contentWithNewline}`;

    // Calculate the relative filename for database storage
    const relativeFilename = path.relative(MEMORY_ROOT, targetFilePath);

    // Ensure directory exists
    await fs.mkdir(path.dirname(targetFilePath), { recursive: true });

    // Write the file
    await fs.writeFile(targetFilePath, fullContent, "utf-8");

    // Update database
    const db = new MemoryDB(DB_PATH);

    try {
      // Check if memory already exists in DB
      const existing = db.getMemory(relativeFilename);

      // If updating existing memory, snapshot to changes table first
      if (existing) {
        db.snapshotToChanges(existing);
      }

      const parsed: ParsedMemory = {
        filename: relativeFilename,
        frontmatter,
        content: fullContent,
        rawContent: finalContentWithoutFrontmatter,
      };

      db.upsertMemory(parsed);

      // Extract and store sections only for section-based categories
      if ((SECTION_BASED_CATEGORIES as readonly string[]).includes(categorization.category)) {
        const sections = extractSections(finalContentWithoutFrontmatter);
        for (const sectionTitle of sections) {
          db.upsertSection(relativeFilename, sectionTitle, categorization.summary);
        }
      }

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
        `touch -t ${formatTouchTime(frontmatter.updated_at)} "${targetFilePath}"`
      );
    } catch (error) {
      console.warn("Warning: Could not set filesystem timestamps:", error);
      // Non-fatal - continue
    }

    return {
      success: true,
      filename: relativeFilename,
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
  content: string,
  existingSections: Array<{ file_path: string; section_title: string; summary: string | null }>
): Promise<LibbyCategorizationResult> {
  // In Nuxt, we need to use process.cwd() to get to the project root
  const projectRoot = process.cwd();
  const scriptPath = path.join(projectRoot, "libby/libby-categorize.sh");

  // Format existing sections for Libby
  const sectionsContext = formatSectionsForLibby(existingSections);

  try {
    // Pass both content and sections context to Libby
    const { stdout } = await execFileAsync(scriptPath, [content, sectionsContext]);
    const result = JSON.parse(stdout.trim()) as LibbyCategorizationResult;
    return result;
  } catch (error) {
    throw new Error(
      `Libby categorization failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Format sections for Libby's prompt
 */
function formatSectionsForLibby(
  sections: Array<{ file_path: string; section_title: string; summary: string | null }>
): string {
  if (sections.length === 0) {
    return "No existing sections yet.";
  }

  // Group by file
  const byFile = new Map<string, Array<{ section_title: string; summary: string | null }>>();

  for (const section of sections) {
    if (!byFile.has(section.file_path)) {
      byFile.set(section.file_path, []);
    }
    byFile.get(section.file_path)!.push({
      section_title: section.section_title,
      summary: section.summary
    });
  }

  // Format as readable list
  const lines: string[] = ["Existing sections:"];
  for (const [filePath, fileSections] of byFile.entries()) {
    lines.push(`- ${filePath}:`);
    for (const { section_title, summary } of fileSections) {
      if (summary) {
        lines.push(`  * ${section_title} (${summary})`);
      } else {
        lines.push(`  * ${section_title}`);
      }
    }
  }

  return lines.join("\n");
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
