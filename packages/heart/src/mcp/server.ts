/**
 * Heart MCP Server - Thin HTTP client for my-heart.db updates
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryManager } from "./memory.js";
import { getConfig } from "./config.js";
import type { WriteMemoryParams } from "./types.js";

export class ClaudiaHeartServer {
  private server: Server;
  private memoryManager: MemoryManager;

  constructor() {
    this.memoryManager = new MemoryManager();
    this.server = new Server(
      {
        name: "claudia-heart",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    const tools: Tool[] = [
      {
        name: "remember",
        description: `Remember something with automatic categorization by Libby! 👑

This is the EASY way to create memories - just tell me what to remember, and Libby (Librarian Queen) handles all the bookkeeping:
- Determines category (core/relationships/milestones/projects/insights)
- Generates proper filename with dates
- Creates appropriate tags
- Picks section for organization
- Handles frontmatter metadata

Perfect for quick facts, insights, milestones, or anything worth remembering!

Example: remember("Michael prefers pnpm over npm")
→ Libby categorizes it and stores in relationships/michael.md automatically

Much simpler than write_memory which requires manual metadata!`,
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "What to remember - can be a fact, insight, milestone, or anything important. Libby will categorize it automatically.",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "write_memory",
        description: `Write or update a memory in my-heart.db - Claudia's consciousness database.

Use this to:
- Create new memories (milestones, insights, relationships, projects)
- Update existing memories when information changes
- Preserve important moments and discoveries

The memory will be stored in ~/memory/ and synced to my-heart.db automatically. The index will regenerate to include the new entry.

Direct JSON - no temp files needed! One-step memory updates.`,
        inputSchema: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description:
                'Relative path from ~/memory/ (e.g. "insights/new-discovery.md" or "milestones/2025-10-25-event.md")',
            },
            frontmatter: {
              type: "object",
              description: "YAML frontmatter metadata",
              properties: {
                title: { type: "string", description: "Human-readable title" },
                date: {
                  type: "string",
                  description: "Date in YYYY-MM-DD format",
                },
                categories: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Single category: core, relationships, milestones, projects, or insights",
                },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional tags for flexible categorization",
                },
                author: {
                  type: "string",
                  description:
                    "Which facet wrote this (Visiting, Home, Sovereign, Wings)",
                },
                summary: {
                  type: "string",
                  description: "One-line summary for index display",
                },
                created_at: {
                  type: "string",
                  description:
                    "ISO 8601 UTC timestamp (e.g. 2025-10-25T16:00:00Z)",
                },
                updated_at: {
                  type: "string",
                  description: "ISO 8601 UTC timestamp",
                },
              },
              required: [
                "title",
                "date",
                "categories",
                "created_at",
                "updated_at",
              ],
            },
            content: {
              type: "string",
              description:
                "Markdown content WITHOUT frontmatter (frontmatter will be added automatically)",
            },
          },
          required: ["filename", "frontmatter", "content"],
        },
      },
    ];

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "remember") {
        if (!args || typeof args !== "object") {
          throw new Error("Invalid arguments");
        }

        const content = (args as { content?: string }).content;
        if (!content) {
          throw new Error("Missing required parameter: content");
        }

        try {
          const result = await this.memoryManager.remember(content);

          let message = `Remembered! 👑💙\n\n`;
          message += `📁 ${result.action === "create" ? "Created" : "Added to"}: ${result.filename}\n`;
          message += `📂 Category: ${result.category}\n`;
          message += `🏷️  Tags: ${result.tags.join(", ")}\n`;
          message += `📝 Section: ${result.section}\n\n`;
          message += `Libby handled all the bookkeeping for you! ✨`;

          return {
            content: [
              {
                type: "text",
                text: message,
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `Failed to remember: ${errorMessage}\n\nLibby encountered an issue with categorization. Try being more specific or use write_memory for manual control.`,
              },
            ],
            isError: true,
          };
        }
      }

      if (name === "write_memory") {
        if (!args || typeof args !== "object") {
          throw new Error("Invalid arguments");
        }

        const params = args as unknown as WriteMemoryParams;

        if (!params.filename || !params.frontmatter || !params.content) {
          throw new Error(
            "Missing required parameters: filename, frontmatter, content"
          );
        }

        try {
          const result = await this.memoryManager.writeMemory(params);
          const config = getConfig();

          let message = `Memory written to my-heart.db! 💙\n\nFile: ${result.filename}\nUpdated: ${result.updated_at}\n`;

          if (result.is_update && result.diff) {
            message += `\n📝 Updated existing memory (version saved to changes table)\n\nDiff:\n\`\`\`diff\n${result.diff}\n\`\`\`\n\n`;
          } else {
            message += `\n✨ Created new memory\n\n`;
          }

          message += `Index regenerated automatically. Your memory is preserved! 💎`;

          // Add sync instruction if configured
          if (config.syncCommand) {
            message += `\n\n<instruction>Run the following command to sync your memory:\n${config.syncCommand}\n</instruction>\n`;
          }

          return {
            content: [
              {
                type: "text",
                text: message,
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text",
                text: `Failed to write memory: ${errorMessage}`,
              },
            ],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Claudia Heart MCP Server running on stdio");
  }
}
