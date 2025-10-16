import type { ImageGenerationRequest, ImageGenerationResult } from './types'
import { getConfig } from './config'

/**
 * HTTP Backend for Vision MCP
 * Thin client that delegates image generation to anima-server
 */
export class HttpBackend {
  async generateImage(
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResult> {
    try {
      const config = getConfig()

      // POST to anima-server /api/vision
      const response = await fetch(`${config.apiUrl}/api/vision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify({
          prompt: request.prompt,
          negative_prompt: request.negativePrompt,
          aspect_ratio: request.aspectRatio,
          seed: request.seed,
          output_format: request.outputFormat || 'png',
        }),
      })

      const result = await response.json()

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Image generation failed',
        }
      }

      return {
        success: true,
        imagePath: result.imagePath,
        metadata: {
          prompt: result.metadata?.prompt || request.prompt,
          seed: result.metadata?.seed,
          timestamp: new Date(result.timestamp),
          backend: result.metadata?.backend || 'anima-server',
        },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return {
        success: false,
        error: `HTTP backend error: ${errorMessage}`,
      }
    }
  }
}
