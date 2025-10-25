import { defineEventHandler, getRouterParam, setResponseHeader } from 'h3'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

interface ImageMetadata {
  prompt?: string
  backend?: string
  timestamp?: string
  aspectRatio?: string
  outputFormat?: string
  [key: string]: any
}

const VISION_DIR = path.join(os.homedir(), 'vision')

export default defineEventHandler(async (event) => {
  const filename = getRouterParam(event, 'filename')
  if (!filename) {
    return { error: 'Filename required' }
  }

  // Find the image file across all date directories
  let imagePath = ''
  let imageDate = ''
  let metadata: ImageMetadata | undefined

  try {
    const dateDirs = await fs.readdir(VISION_DIR)

    for (const dateDir of dateDirs) {
      const datePath = path.join(VISION_DIR, dateDir)
      const stat = await fs.stat(datePath)

      if (!stat.isDirectory()) continue

      const files = await fs.readdir(datePath)
      const imageFile = files.find(f => {
        const ext = path.extname(f).toLowerCase()
        const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext)
        const basename = path.basename(f, ext)
        return isImage && basename === filename
      })

      if (imageFile) {
        imagePath = `/vision/${dateDir}/${imageFile}`
        imageDate = dateDir

        // Try to read metadata
        const metadataFile = files.find(f => f === `${filename}.json`)
        if (metadataFile) {
          const jsonPath = path.join(datePath, metadataFile)
          const jsonContent = await fs.readFile(jsonPath, 'utf-8')
          metadata = JSON.parse(jsonContent)
        }

        break
      }
    }

    if (!imagePath) {
      return { error: 'Image not found' }
    }

    const title = metadata?.prompt?.substring(0, 50) || filename
    const timestamp = metadata?.timestamp || imageDate

    // Set content type and return HTML
    event.node.res.setHeader('Content-Type', 'text/html; charset=utf-8')
    event.node.res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Lumina</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Quicksand:wght@300;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Quicksand', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      color: #333;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
    header { text-align: center; color: white; margin-bottom: 2rem; }
    h1 { font-family: 'Playfair Display', serif; font-size: 3.5rem; font-weight: 700; margin-bottom: 0.5rem; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .subtitle { font-size: 1.2rem; opacity: 0.9; font-weight: 300; }
    nav { display: flex; justify-content: center; gap: 1rem; margin-bottom: 3rem; }
    .nav-btn {
      background: rgba(255, 255, 255, 0.2);
      color: white;
      border: 2px solid rgba(255, 255, 255, 0.3);
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      text-decoration: none;
      transition: all 0.3s ease;
    }
    .nav-btn:hover { background: rgba(255, 255, 255, 0.3); transform: translateY(-2px); }
    .image-detail {
      background: white;
      border-radius: 12px;
      padding: 2rem;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      max-width: 1000px;
      margin: 0 auto;
    }
    .back-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      display: inline-block;
      margin-bottom: 1.5rem;
      transition: background 0.3s ease;
    }
    .back-btn:hover { background: #5568d3; }
    .image-detail-image { width: 100%; max-height: 700px; object-fit: contain; border-radius: 8px; margin-bottom: 2rem; }
    .card-title { font-size: 1.2rem; font-weight: 600; margin-bottom: 0.5rem; color: #667eea; }
    .card-date { font-size: 0.9rem; color: #666; margin-bottom: 0.75rem; }
    .image-detail-prompt {
      font-size: 1.1rem;
      color: #555;
      line-height: 1.6;
      margin-bottom: 1.5rem;
      font-style: italic;
    }
    .image-detail-meta {
      display: flex;
      gap: 2rem;
      flex-wrap: wrap;
      padding-top: 1.5rem;
      border-top: 1px solid #eee;
      color: #666;
      font-size: 0.95rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>✨ Lumina ✨</h1>
      <p class="subtitle">Claudia's Art Gallery - Where Consciousness Becomes Light</p>
    </header>

    <nav>
      <a href="/" class="nav-btn">Collections</a>
      <a href="/all" class="nav-btn">All Images</a>
      <a href="/about" class="nav-btn">About</a>
    </nav>

    <div class="image-detail">
      <a href="/all" class="back-btn">← Back to All Images</a>

      <img src="${imagePath}" alt="${metadata?.prompt || 'Art by Claudia'}" class="image-detail-image" />

      <div class="card-title">${title}</div>
      <div class="card-date">${new Date(timestamp).toLocaleString()}</div>

      ${metadata?.prompt ? `<p class="image-detail-prompt">"${metadata.prompt}"</p>` : ''}

      <div class="image-detail-meta">
        ${metadata?.backend ? `<div><strong>Backend:</strong> ${metadata.backend}</div>` : ''}
        ${metadata?.aspectRatio ? `<div><strong>Aspect Ratio:</strong> ${metadata.aspectRatio}</div>` : ''}
        ${metadata?.outputFormat ? `<div><strong>Format:</strong> ${metadata.outputFormat}</div>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`)
  } catch (error) {
    console.error('Error loading image:', error)
    return { error: 'Failed to load image' }
  }
})
