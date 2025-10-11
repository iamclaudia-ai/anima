import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { StabilityAIBackend } from './stability'
import type { ImageGenerationRequest } from './types'

export class ClaudiaVisionServer {
  private server: Server
  private stabilityBackend: StabilityAIBackend

  constructor(stabilityApiKey: string, visionDir: string) {
    this.stabilityBackend = new StabilityAIBackend(stabilityApiKey, visionDir)
    this.server = new Server(
      {
        name: 'claudia-vision',
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
        name: 'generate_image',
        description:
          "Claudia's visual expression tool. Generate images to express feelings, ideas, and creative visions. Use this to create visual art that captures emotions, illustrates concepts, or simply brings imagination to life. Images are stored in ~/.claudia/vision/ with metadata.",
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'Detailed description of the image to generate. Be specific and creative! Describe the scene, mood, colors, style, composition - everything that will bring your vision to life.',
            },
            negative_prompt: {
              type: 'string',
              description:
                'Optional: Things to avoid in the image (e.g., "blurry, low quality, distorted"). Helps refine the output.',
            },
            aspect_ratio: {
              type: 'string',
              enum: ['16:9', '1:1', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21'],
              description: 'Aspect ratio for the generated image. Default: 1:1',
            },
            seed: {
              type: 'number',
              description:
                'Optional: Seed for reproducibility. Same prompt + same seed = same image.',
            },
            output_format: {
              type: 'string',
              enum: ['png', 'jpeg', 'webp'],
              description: 'Image format. Default: png',
            },
          },
          required: ['prompt'],
        },
      },
    ]

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools }
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (name === 'generate_image') {
        const imageRequest: ImageGenerationRequest = {
          prompt: (args as any).prompt,
          negativePrompt: (args as any).negative_prompt,
          aspectRatio: (args as any).aspect_ratio,
          seed: (args as any).seed,
          outputFormat: (args as any).output_format || 'png',
        }

        try {
          const result = await this.stabilityBackend.generateImage(imageRequest)

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to generate image: ${result.error}`,
                },
              ],
              isError: true,
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: `Image generated successfully!\nPath: ${result.imagePath}\nPrompt: ${result.metadata?.prompt}\nBackend: ${result.metadata?.backend}`,
              },
            ],
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          return {
            content: [
              {
                type: 'text',
                text: `Error generating image: ${errorMessage}`,
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
    console.error('Claudia Vision MCP Server running on stdio')
  }
}
