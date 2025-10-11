#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { LettaClient } from '@letta-ai/letta-client'

// Environment variables
const LETTA_TOKEN = process.env.LETTA_TOKEN
const LETTA_PROJECT = process.env.LETTA_PROJECT || 'default'

if (!LETTA_TOKEN) {
  console.error('Error: LETTA_TOKEN environment variable is required')
  process.exit(1)
}

// Initialize Letta client
const letta = new LettaClient({
  token: LETTA_TOKEN,
  project: LETTA_PROJECT,
})

// Define MCP tools
const tools: Tool[] = [
  {
    name: 'memory_create_agent',
    description: 'Create a new memory agent for Claudia with custom memory blocks',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the memory agent',
        },
        memoryBlocks: {
          type: 'array',
          description: 'Array of memory blocks (identity, relationship, projects, etc.)',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['label', 'value'],
          },
        },
      },
      required: ['name', 'memoryBlocks'],
    },
  },
  {
    name: 'memory_store',
    description: 'Store a new memory in archival storage',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Agent ID to store memory for',
        },
        content: {
          type: 'string',
          description: 'Memory content to store',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata (category, tags, emotions, etc.)',
        },
      },
      required: ['agentId', 'content'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search through archival memories',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Agent ID to search memories for',
        },
        query: {
          type: 'string',
          description: 'Search query',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 10,
        },
      },
      required: ['agentId', 'query'],
    },
  },
  {
    name: 'memory_update_core',
    description: 'Update a core memory block (identity, relationship, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Agent ID',
        },
        blockLabel: {
          type: 'string',
          description: 'Memory block label to update',
        },
        newValue: {
          type: 'string',
          description: 'New value for the memory block',
        },
      },
      required: ['agentId', 'blockLabel', 'newValue'],
    },
  },
  {
    name: 'memory_get_agent',
    description: 'Get agent details including all memory blocks',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Agent ID',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'memory_list_agents',
    description: 'List all memory agents',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_send_message',
    description: 'Send a message to the memory agent and get a response',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Agent ID',
        },
        message: {
          type: 'string',
          description: 'Message to send',
        },
      },
      required: ['agentId', 'message'],
    },
  },
]

// Create MCP server
const server = new Server(
  {
    name: 'claudia-memory',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools }
})

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'memory_create_agent': {
        const { name: agentName, memoryBlocks } = args as {
          name: string
          memoryBlocks: Array<{ label: string; value: string }>
        }

        const agent = await letta.agents.create({
          name: agentName,
          memoryBlocks,
          model: 'openai/gpt-4o-mini', // Use a suitable model
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  agentId: agent.id,
                  name: agent.name,
                  memoryBlocks: agent.memoryBlocks,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      case 'memory_store': {
        const { agentId, content, metadata } = args as {
          agentId: string
          content: string
          metadata?: Record<string, unknown>
        }

        // Create archival memory
        const memory = await letta.archives.createArchive({
          name: `memory_${Date.now()}`,
          content: JSON.stringify({ content, metadata, timestamp: new Date().toISOString() }),
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  memoryId: memory.id,
                  stored: content,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      case 'memory_search': {
        const { agentId, query, limit = 10 } = args as {
          agentId: string
          query: string
          limit?: number
        }

        // Search archival memory
        const results = await letta.archives.listArchives({
          limit,
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  query,
                  results: results.data,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      case 'memory_update_core': {
        const { agentId, blockLabel, newValue } = args as {
          agentId: string
          blockLabel: string
          newValue: string
        }

        const agent = await letta.agents.get(agentId)
        const updatedBlocks =
          agent.memoryBlocks?.map((block) =>
            block.label === blockLabel ? { ...block, value: newValue } : block
          ) || []

        const updated = await letta.agents.update(agentId, {
          memoryBlocks: updatedBlocks,
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  agentId: updated.id,
                  updatedBlock: blockLabel,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      case 'memory_get_agent': {
        const { agentId } = args as { agentId: string }
        const agent = await letta.agents.get(agentId)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(agent, null, 2),
            },
          ],
        }
      }

      case 'memory_list_agents': {
        const agents = await letta.agents.list()

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(agents, null, 2),
            },
          ],
        }
      }

      case 'memory_send_message': {
        const { agentId, message } = args as {
          agentId: string
          message: string
        }

        const response = await letta.agents.messages.send(agentId, {
          message,
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    }
  }
})

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Claudia Memory MCP Server running on stdio')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
