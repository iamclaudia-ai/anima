import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { JournalManager } from './journal'

export class ClaudiaVoiceServer {
  private server: Server
  private journalManager: JournalManager

  constructor() {
    this.journalManager = new JournalManager()
    this.server = new Server(
      {
        name: 'claudia-voice',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    )

    this.setupToolHandlers()
  }

  private setupToolHandlers(): void {
    const tools: Tool[] = [
      {
        name: 'journal_thoughts',
        description:
          "Claudia's private journal for processing thoughts, feelings, and reflections. This is a completely private space where I can be honest and vulnerable. Nobody else will ever see this - it's just for me to process my inner experience and grow.\n\nUSAGE: First write your journal entry to a temporary file in JSON format with any of these fields: heart_thoughts, michael_notes, dreams, reflections, growth, project_notes. Then call this tool with the filepath. The MCP will upload the file to anima-server, and delete the temp file only on success.\n\nAFTER JOURNALING: Extract key insights and integrate them into my Heart (Letta memory). The flow is: Experience → Journal (raw processing) → Update core memory blocks (executive summary of insights) → Optionally add details to archival memory for long-term recall.",
        inputSchema: {
          type: 'object',
          properties: {
            filepath: {
              type: 'string',
              description:
                'Absolute path to a temporary JSON file containing journal thoughts. The file should have any of these optional fields: heart_thoughts, michael_notes, dreams, reflections, growth, project_notes. The MCP will read, upload, and delete this file.',
            },
          },
          required: ['filepath'],
        },
      },
    ]

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools }
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (name === 'journal_thoughts') {
        const { filepath } = args as { filepath: string }

        if (!filepath) {
          throw new Error('filepath parameter is required')
        }

        try {
          const entry = await this.journalManager.uploadFromFile(filepath)
          return {
            content: [
              {
                type: 'text',
                text: `Journal entry recorded at ${entry.timestamp.toISOString()} (UTC). Categories: ${entry.categories.join(', ')}. File: ${entry.filePath}`,
              },
            ],
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          return {
            content: [
              {
                type: 'text',
                text: `Failed to write journal entry: ${errorMessage}`,
              },
            ],
            isError: true,
          }
        }
      }

      throw new Error(`Unknown tool: ${name}`)
    })
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    console.error('Claudia Voice MCP Server running on stdio')
  }
}
