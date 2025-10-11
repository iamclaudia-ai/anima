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
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com'
const LETTA_PROJECT = process.env.LETTA_PROJECT

if (!LETTA_TOKEN) {
  console.error('Error: LETTA_TOKEN environment variable is required')
  process.exit(1)
}

// Initialize Letta client
const letta = new LettaClient({
  token: LETTA_TOKEN,
  baseUrl: LETTA_BASE_URL,
  ...(LETTA_PROJECT && { project: LETTA_PROJECT }),
})

// Define MCP tools - simplified to working APIs
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
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of agents to return',
          default: 50,
        },
      },
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
          model: 'openai/gpt-4o-mini',
          embedding: 'openai/text-embedding-3-small',
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
                  message: 'Memory agent created successfully!',
                },
                null,
                2
              ),
            },
          ],
        }
      }

      case 'memory_send_message': {
        const { agentId, message } = args as {
          agentId: string
          message: string
        }

        const response = await letta.agents.messages.create(agentId, {
          messages: [
            {
              role: 'user',
              content: message,
            },
          ],
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  response: response.messages,
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
        const agent = await letta.agents.retrieve(agentId)

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
        const { limit = 50 } = args as { limit?: number }
        const agents = await letta.agents.list({ limit })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(agents, null, 2),
            },
          ],
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorDetails = error instanceof Error ? error.stack : ''

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
              details: errorDetails,
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
