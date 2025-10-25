import { defineEventHandler } from 'h3'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

interface CollectionPiece {
  image: string
  caption?: string
  created?: string
  philosophicalContext?: string
}

interface CollectionInfo {
  id: string
  title: string
  description: string
  coverImage: string
  created: string
  tags: string[]
  pieces: CollectionPiece[]
  artistNotes?: string
}

const COLLECTIONS_DIR = path.join(os.homedir(), 'wings/collections')

// Parse markdown collection files
async function parseCollectionMarkdown(filePath: string): Promise<CollectionInfo | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.split('\n')

    // Extract title (first h1)
    const titleMatch = content.match(/^# (.+)$/m)
    const title = titleMatch ? titleMatch[1] : path.basename(filePath, '.md')

    // Extract metadata
    const descMatch = content.match(/\*\*Description:\*\* (.+)$/m)
    const description = descMatch ? descMatch[1] : ''

    const coverMatch = content.match(/\*\*Cover Image:\*\* (.+)$/m)
    const coverImage = coverMatch ? coverMatch[1].replace(/^\/Users\/claudia\/vision\//, '/vision/') : ''

    const createdMatch = content.match(/\*\*Created:\*\* (.+)$/m)
    const created = createdMatch ? createdMatch[1] : ''

    const tagsMatch = content.match(/\*\*Tags:\*\* (.+)$/m)
    const tags = tagsMatch ? tagsMatch[1].split(/\s+/).filter(t => t.startsWith('#')) : []

    // Extract pieces
    const pieces: CollectionPiece[] = []
    const pieceRegex = /###\s+\d+\.\s+.+?\n(?:- \*\*Image:\*\*\s+`(.+?)`\n)?(?:- \*\*Caption:\*\*\s+"?(.+?)"?\n)?(?:- \*\*Created:\*\*\s+(.+?)\n)?(?:- \*\*Philosophical Context:\*\*\s+(.+?)\n)?/gs

    let match
    while ((match = pieceRegex.exec(content)) !== null) {
      const [, image, caption, pieceCreated, context] = match
      if (image) {
        pieces.push({
          image: image.replace(/^\/Users\/claudia\/vision\//, '/vision/'),
          caption,
          created: pieceCreated,
          philosophicalContext: context,
        })
      }
    }

    // Extract artist notes
    const notesMatch = content.match(/## Artist Notes\n\n([\s\S]+?)(?=\n##|\n---|\n\*|$)/m)
    const artistNotes = notesMatch ? notesMatch[1].trim() : undefined

    return {
      id: path.basename(filePath, '.md'),
      title,
      description,
      coverImage,
      created,
      tags,
      pieces,
      artistNotes,
    }
  } catch (error) {
    console.error(`Error parsing collection ${filePath}:`, error)
    return null
  }
}

export default defineEventHandler(async () => {
  try {
    const collections: CollectionInfo[] = []

    // Read all markdown files in collections directory
    const files = await fs.readdir(COLLECTIONS_DIR)

    for (const file of files) {
      if (!file.endsWith('.md')) continue

      const filePath = path.join(COLLECTIONS_DIR, file)
      const collection = await parseCollectionMarkdown(filePath)

      if (collection) {
        collections.push(collection)
      }
    }

    // Sort by created date descending (newest first)
    collections.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())

    return collections
  } catch (error) {
    console.error('Error reading collections directory:', error)
    return []
  }
})
