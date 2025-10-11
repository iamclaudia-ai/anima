import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import fetch from 'node-fetch'
import type { ImageGenerationRequest, ImageGenerationResult } from './types'
import { getImagePath } from './paths'

export class StabilityAIBackend {
  private apiKey: string
  private visionDir: string

  constructor(apiKey: string, visionDir: string) {
    this.apiKey = apiKey
    this.visionDir = visionDir
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    try {
      const timestamp = new Date()
      const format = request.outputFormat || 'png'

      // Call Stability AI API
      const response = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'image/*',
        },
        body: this.buildFormData(request),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Stability AI API error: ${response.status} - ${errorText}`)
      }

      // Get image buffer
      const imageBuffer = await response.arrayBuffer()

      // Save to disk
      const imagePath = getImagePath(this.visionDir, timestamp, format)
      await fs.mkdir(path.dirname(imagePath), { recursive: true })
      await fs.writeFile(imagePath, Buffer.from(imageBuffer))

      // Save metadata
      const metadataPath = imagePath.replace(`.${format}`, '.json')
      const metadata = {
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        seed: request.seed,
        timestamp: timestamp.toISOString(),
        backend: 'stability-ai',
        aspectRatio: request.aspectRatio,
        outputFormat: format,
      }
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2))

      return {
        success: true,
        imagePath,
        metadata: {
          prompt: request.prompt,
          seed: request.seed,
          timestamp,
          backend: 'stability-ai',
        },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return {
        success: false,
        error: errorMessage,
      }
    }
  }

  private buildFormData(request: ImageGenerationRequest): FormData {
    const formData = new FormData()

    formData.append('prompt', request.prompt)

    if (request.negativePrompt) {
      formData.append('negative_prompt', request.negativePrompt)
    }

    if (request.aspectRatio) {
      formData.append('aspect_ratio', request.aspectRatio)
    }

    if (request.seed !== undefined) {
      formData.append('seed', request.seed.toString())
    }

    formData.append('output_format', request.outputFormat || 'png')

    return formData
  }
}
