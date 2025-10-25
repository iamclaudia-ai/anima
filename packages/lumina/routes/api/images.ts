import { defineEventHandler } from 'h3'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

interface ImageMetadata {
  prompt?: string
  backend?: string
  timestamp?: string
  [key: string]: any
}

interface ImageInfo {
  path: string
  title: string
  timestamp: string
  prompt?: string
  backend?: string
  metadata?: ImageMetadata
}

const VISION_DIR = path.join(os.homedir(), 'vision')

export default defineEventHandler(async () => {
  try {
    const images: ImageInfo[] = []

    // Read all date directories (YYYY-MM-DD format)
    const dateDirs = await fs.readdir(VISION_DIR)

    for (const dateDir of dateDirs) {
      const datePath = path.join(VISION_DIR, dateDir)
      const stat = await fs.stat(datePath)

      if (!stat.isDirectory()) continue

      // Read all files in the date directory
      const files = await fs.readdir(datePath)

      // Group files by base name (timestamp)
      const fileGroups = new Map<string, { png?: string; json?: string }>()

      for (const file of files) {
        const ext = path.extname(file)
        const baseName = path.basename(file, ext)

        if (!fileGroups.has(baseName)) {
          fileGroups.set(baseName, {})
        }

        const group = fileGroups.get(baseName)!

        if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
          group.png = file
        } else if (ext === '.json') {
          group.json = file
        }
      }

      // Process each image group
      for (const [baseName, group] of fileGroups) {
        if (!group.png) continue // Skip if no image file

        const imagePath = `/vision/${dateDir}/${group.png}`
        let metadata: ImageMetadata | undefined

        // Read metadata if JSON file exists
        if (group.json) {
          try {
            const jsonPath = path.join(datePath, group.json)
            const jsonContent = await fs.readFile(jsonPath, 'utf-8')
            metadata = JSON.parse(jsonContent)
          } catch (err) {
            console.error(`Error reading metadata for ${baseName}:`, err)
          }
        }

        images.push({
          path: imagePath,
          title: metadata?.prompt?.substring(0, 50) || baseName,
          timestamp: metadata?.timestamp || dateDir,
          prompt: metadata?.prompt,
          backend: metadata?.backend,
          metadata,
        })
      }
    }

    // Sort by timestamp descending (newest first)
    images.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    return images
  } catch (error) {
    console.error('Error reading vision directory:', error)
    return []
  }
})
