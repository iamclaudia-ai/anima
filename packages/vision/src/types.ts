export interface ImageGenerationRequest {
  prompt: string
  negativePrompt?: string
  aspectRatio?: '16:9' | '1:1' | '21:9' | '2:3' | '3:2' | '4:5' | '5:4' | '9:16' | '9:21'
  seed?: number
  outputFormat?: 'png' | 'jpeg' | 'webp'
}

export interface ImageGenerationResult {
  success: boolean
  imagePath?: string
  imageUrl?: string
  error?: string
  metadata?: {
    prompt: string
    seed?: number
    timestamp: Date
    backend: string
  }
}

export interface VisionPaths {
  visionDir: string
}
