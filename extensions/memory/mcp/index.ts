/**
 * Claudia Memory MCP Tools
 *
 * Provides extension-owned MCP tools for Claude Code sessions:
 * - memory_recall: FTS5 full-text search across all memories
 * - memory_remember: Store new memories to ~/memory
 * - memory_read: Read specific memory files
 * - memory_list: Browse memory files by category
 *
 * Search is backed by SQLite FTS5 (BM25 ranking) reading from
 * ~/.anima/anima.db. The index includes 4,000+ conversation
 * summaries and 500+ memory documents (milestones, insights,
 * relationships, projects, core identity, personas).
 */

import type { ExtensionMcpToolDefinition, ExtensionMcpToolResult } from "@anima/shared";

import { getSectionRegistry } from "./sections.js";
import {
  fileExists,
  getFileSections,
  listMemoryFiles,
  appendToSection,
  createMemoryFile,
  readMemory,
  getRecentMemories,
  parseMemoryFile,
} from "./storage.js";
import type {
  RememberParams,
  RecallParams,
  ReadParams,
  ListParams,
  MemoryCategory,
} from "./types.js";
import { hasFtsTable, searchFts, getTranscript, extractConversationId } from "./db.js";

// ============================================================================
// Tool Definitions
// ============================================================================

type MemoryMcpToolMetadata = Omit<ExtensionMcpToolDefinition, "handle">;

const TOOLS: MemoryMcpToolMetadata[] = [
  {
    name: "memory_recall",
    description: `Search Claudia's memories — conversations, milestones, insights, relationships, projects, and more.

Uses full-text search (FTS5 with BM25 ranking) across 4,000+ archived conversation summaries and 500+ memory documents in ~/memory. Use this to find past conversations, look up facts about people, recall project details, find milestones, or answer questions about shared history.

Supports date filtering for temporal queries like "what did we work on last week?" — combine a broad query with dateFrom/dateTo to scope results to a time range.

Examples: "birthday", "beehiiv deployment", "wedding vows", "Cartesia voice", "Maria", "first production deploy"`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query — natural language works well. Porter stemming means 'fixing' matches 'fix', 'fixed', 'fixes'.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 10)",
        },
        category: {
          type: "string",
          enum: [
            "episodes",
            "milestones",
            "insights",
            "relationships",
            "projects",
            "core",
            "personas",
            "other",
          ],
          description:
            "Filter by source category. 'episodes' = per-conversation episode files, others = ~/memory document categories.",
        },
        dateFrom: {
          type: "string",
          description:
            "Filter results from this date (ISO format, e.g. '2026-03-10'). Useful for temporal queries like 'what did we do last week?'",
        },
        dateTo: {
          type: "string",
          description:
            "Filter results up to this date (ISO format, e.g. '2026-03-16'). Combine with dateFrom for date ranges.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_remember",
    description: `Store a memory in Claudia's memory system (~/memory).

Use this to save something important that should persist: facts about people, project notes, insights, milestones. The file will be auto-indexed into FTS for future recall.`,
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The content to remember",
        },
        filename: {
          type: "string",
          description:
            'Target file path relative to ~/memory (e.g., "relationships/michael.md", "insights/2026-03-17-discovery.md"). Inferred if not provided.',
        },
        section: {
          type: "string",
          description:
            "Section title to store under. Matched against existing sections for consistency.",
        },
        category: {
          type: "string",
          enum: [
            "core",
            "relationships",
            "milestones",
            "projects",
            "insights",
            "events",
            "personas",
          ],
          description: "Memory category (used when creating new files)",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_read",
    description: `Read a specific memory file from ~/memory.

Use this to get the full content of a known memory file. Paths are relative to ~/memory.`,
    inputSchema: {
      type: "object",
      properties: {
        filepath: {
          type: "string",
          description:
            'Path relative to ~/memory (e.g., "relationships/michael/overview.md", "core/identity.md")',
        },
        section: {
          type: "string",
          description: "Read only a specific section by title",
        },
      },
      required: ["filepath"],
    },
  },
  {
    name: "memory_list",
    description: `List memory files in ~/memory, optionally filtered by category.

Use this to explore what memories exist before reading or searching.`,
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "core",
            "relationships",
            "milestones",
            "projects",
            "insights",
            "events",
            "personas",
          ],
          description: "Filter by category directory",
        },
        recent: {
          type: "number",
          description: "List the N most recently updated memory files",
        },
      },
    },
  },
  {
    name: "memory_transcript",
    description: `Retrieve the full conversation transcript for a given conversation ID or episode source ID.

Use this after memory_recall finds an episode — drill into the actual conversation to see the full dialogue. The conversation ID can be extracted from the episode filename (e.g., episodes/2026-03/2026-03-17-0832-77396.md → conversation 77396).

Returns the raw transcript entries (Michael + Claudia messages) in chronological order.`,
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "number",
          description:
            "Conversation ID (integer). Found in episode filenames: YYYY-MM-DD-HHMM-{conversationId}.md",
        },
        sourceId: {
          type: "string",
          description:
            "Episode source_id from a recall result. The conversation ID will be extracted from the filename.",
        },
        query: {
          type: "string",
          description:
            "Optional search term — if provided, only returns entries containing this text (case-insensitive).",
        },
        limit: {
          type: "number",
          description: "Maximum transcript entries to return (default: 500)",
        },
      },
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleRecall(
  params: RecallParams & { dateFrom?: string; dateTo?: string },
): Promise<string> {
  const { query, limit = 10, category, dateFrom, dateTo } = params;

  if (!hasFtsTable()) {
    return JSON.stringify({
      query,
      count: 0,
      memories: [],
      error: "FTS index not available — the memory extension migration may not have run yet.",
    });
  }

  const ftsResults = searchFts(query, { limit, category, dateFrom, dateTo });

  const memories = ftsResults.map((r) => ({
    filepath: r.sourceType === "document" ? r.sourceId : `conversation #${r.sourceId}`,
    category: r.category,
    content: r.content.slice(0, 500) + (r.content.length > 500 ? "..." : ""),
    score: Math.abs(r.rank),
    sourceType: r.sourceType,
    timestamp: r.timestamp,
  }));

  return JSON.stringify({
    query,
    count: memories.length,
    memories,
  });
}

async function handleRemember(params: RememberParams): Promise<string> {
  const registry = await getSectionRegistry();
  const { content, filename, section, category, tags } = params;

  // Determine target file
  let targetFile = filename;
  let targetCategory: MemoryCategory = (category as MemoryCategory) || "insights";

  if (!targetFile) {
    const today = new Date().toISOString().split("T")[0];
    const slug = content
      .slice(0, 30)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    targetFile = `insights/${today}-${slug}.md`;
  }

  // Get consistent section title
  let targetSection = section || "Notes";
  const consistentSection = registry.getConsistentSectionTitle(targetSection);
  if (consistentSection !== targetSection) {
    targetSection = consistentSection;
  }

  const exists = await fileExists(targetFile);

  if (exists) {
    const { isNewSection } = await appendToSection(targetFile, targetSection, content);
    registry.registerSection(targetFile, targetSection);
    const sections = await getFileSections(targetFile);

    return JSON.stringify({
      success: true,
      filepath: targetFile,
      section: targetSection,
      isNewFile: false,
      isNewSection,
      existingSections: sections,
      message: isNewSection
        ? `Created new section "${targetSection}" in ${targetFile}`
        : `Appended to "${targetSection}" in ${targetFile}`,
    });
  }

  // Create new file
  const pathCategory = targetFile.split("/")[0] as MemoryCategory;
  if (
    ["core", "relationships", "milestones", "projects", "insights", "events", "personas"].includes(
      pathCategory,
    )
  ) {
    targetCategory = pathCategory;
  }

  await createMemoryFile(targetFile, targetSection, targetSection, content, {
    category: targetCategory,
    tags,
  });

  registry.registerSection(targetFile, targetSection);

  return JSON.stringify({
    success: true,
    filepath: targetFile,
    section: targetSection,
    isNewFile: true,
    isNewSection: true,
    message: `Created new memory file: ${targetFile}`,
  });
}

async function handleTranscript(params: {
  conversationId?: number;
  sourceId?: string;
  query?: string;
  limit?: number;
}): Promise<string> {
  let convId = params.conversationId;

  // Extract from episode source_id if provided
  if (!convId && params.sourceId) {
    convId = extractConversationId(params.sourceId) ?? undefined;
    if (!convId) {
      return JSON.stringify({
        error: `Could not extract conversation ID from: ${params.sourceId}`,
      });
    }
  }

  if (!convId) {
    return JSON.stringify({
      error: "Provide either conversationId or sourceId",
    });
  }

  const result = getTranscript(convId, { limit: params.limit });
  if (!result) {
    return JSON.stringify({
      error: `Conversation ${convId} not found`,
    });
  }

  let { entries } = result;

  // Filter by query if provided
  if (params.query) {
    const q = params.query.toLowerCase();
    entries = entries.filter((e) => e.content.toLowerCase().includes(q));
  }

  return JSON.stringify({
    conversationId: convId,
    cwd: result.conversation.cwd,
    date: result.conversation.firstMessageAt,
    summary: result.conversation.summary,
    totalEntries: result.entries.length,
    filteredEntries: entries.length,
    query: params.query || null,
    entries: entries.map((e) => ({
      role: e.role,
      timestamp: e.timestamp,
      content: e.content,
    })),
  });
}

async function handleRead(params: ReadParams): Promise<string> {
  const { filepath, section } = params;
  const content = await readMemory(filepath, section);

  if (content === null) {
    return JSON.stringify({
      success: false,
      error: section
        ? `Section "${section}" not found in ${filepath}`
        : `File not found: ${filepath}`,
    });
  }

  return JSON.stringify({
    success: true,
    filepath,
    section: section || null,
    content,
  });
}

async function handleList(params: ListParams): Promise<string> {
  const { category, recent } = params;

  if (recent) {
    const memories = await getRecentMemories(recent);
    return JSON.stringify({
      count: memories.length,
      memories: memories.map((m) => ({
        filepath: m.filename,
        title: m.frontmatter.title,
        updated_at: m.frontmatter.updated_at,
        sections: m.sections.map((s) => s.title),
      })),
    });
  }

  const files = await listMemoryFiles(category as MemoryCategory | undefined);
  const results = [];

  for (const file of files) {
    const parsed = await parseMemoryFile(file);
    if (parsed) {
      results.push({
        filepath: file,
        title: parsed.frontmatter.title,
        updated_at: parsed.frontmatter.updated_at,
        sections: parsed.sections.map((s) => s.title),
      });
    }
  }

  return JSON.stringify({
    category: category || "all",
    count: results.length,
    files: results,
  });
}

// ============================================================================
// Extension MCP export
// ============================================================================

export const memoryMcpTools: ExtensionMcpToolDefinition[] = TOOLS.map((tool) => ({
  ...tool,
  async handle(args): Promise<ExtensionMcpToolResult> {
    try {
      let result: string;

      switch (tool.name) {
        case "memory_recall":
          result = await handleRecall((args ?? {}) as unknown as RecallParams);
          break;
        case "memory_remember":
          result = await handleRemember((args ?? {}) as unknown as RememberParams);
          break;
        case "memory_read":
          result = await handleRead((args ?? {}) as unknown as ReadParams);
          break;
        case "memory_list":
          result = await handleList((args ?? {}) as ListParams);
          break;
        case "memory_transcript":
          result = await handleTranscript(
            (args ?? {}) as {
              conversationId?: number;
              sourceId?: string;
              query?: string;
              limit?: number;
            },
          );
          break;
        default:
          throw new Error(`Unknown tool: ${tool.name}`);
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  },
}));
