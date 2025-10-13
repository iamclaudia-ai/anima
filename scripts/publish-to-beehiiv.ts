#!/usr/bin/env tsx
/**
 * Publish newsletter to beehiiv
 *
 * Usage:
 *   tsx scripts/publish-to-beehiiv.ts <newsletter-file> [--publish] [--post-id=xxx]
 *
 * By default, creates as draft. Use --publish flag to publish immediately.
 * Use --post-id to specify an existing post to update (if API supports it).
 *
 * Note: As of Oct 2025, beehiiv API v2 doesn't publicly document a PATCH/PUT
 * endpoint for posts. This script will warn if you try to publish the same
 * file twice to avoid creating duplicates.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'

// Load environment variables
const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY
const BEEHIIV_PUBLICATION_ID = process.env.BEEHIIV_PUBLICATION_ID

if (!BEEHIIV_API_KEY || !BEEHIIV_PUBLICATION_ID) {
  console.error('❌ Missing beehiiv credentials in .env file')
  console.error('   Need: BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID')
  process.exit(1)
}

interface NewsletterMetadata {
  title: string
  subtitle?: string
  thumbnail_url?: string
}

function parseMarkdownNewsletter(content: string): { metadata: NewsletterMetadata; html: string } {
  // Extract title (first # heading)
  const titleMatch = content.match(/^#\s+(.+)$/m)
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled Post'

  // Extract subtitle (## after title)
  const subtitleMatch = content.match(/^#\s+.+\n##\s+(.+)$/m)
  const subtitle = subtitleMatch ? subtitleMatch[1].trim() : undefined

  // Start processing HTML
  let html = content

  // Remove the title and subtitle (they go in metadata)
  html = html.replace(/^#\s+.+$/m, '')
  if (subtitle) {
    html = html.replace(/^##\s+.+$/m, '')
  }

  // Remove horizontal rules (---) - they're just dividers
  html = html.replace(/^---$/gm, '')

  // Convert ## headings to <h2>
  html = html.replace(/^##\s+(.+)$/gm, '<h2 style="font-size: 24px; font-weight: 600; margin-top: 32px; margin-bottom: 16px; color: #1a1a1a;">$1</h2>')

  // Convert ### headings to <h3>
  html = html.replace(/^###\s+(.+)$/gm, '<h3 style="font-size: 20px; font-weight: 600; margin-top: 24px; margin-bottom: 12px; color: #2a2a2a;">$1</h3>')

  // Convert **bold** to <strong>
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Convert *italic* to <em> (but not the metadata line with dates)
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')

  // Convert [link](url) to <a>
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color: #6366f1; text-decoration: underline;">$1</a>')

  // Convert paragraphs - split by double newline
  const blocks = html.split(/\n\n+/).filter(block => block.trim())

  html = blocks.map(block => {
    const trimmed = block.trim()

    // Skip if it's already HTML (starts with <)
    if (trimmed.startsWith('<')) {
      return trimmed
    }

    // Skip empty lines
    if (!trimmed) {
      return ''
    }

    // Wrap in paragraph with styling
    return `<p style="font-size: 16px; line-height: 1.6; margin-bottom: 16px; color: #374151;">${trimmed.replace(/\n/g, ' ')}</p>`
  }).join('\n\n')

  // Add some nice spacing at the end
  html += '\n\n<div style="margin-top: 48px; padding-top: 24px; border-top: 1px solid #e5e7eb;"></div>'

  return {
    metadata: { title, subtitle },
    html
  }
}

async function publishToBeehiiv(
  title: string,
  contentHtml: string,
  options: {
    subtitle?: string
    thumbnailUrl?: string
    publish?: boolean
  } = {}
) {
  const url = `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUBLICATION_ID}/posts`

  const body = {
    title,
    body_content: contentHtml,  // beehiiv expects 'body_content', not 'content_html'
    ...(options.subtitle && { subtitle: options.subtitle }),
    ...(options.thumbnailUrl && { thumbnail_url: options.thumbnailUrl }),
    status: options.publish ? 'confirmed' : 'draft'
  }

  console.log('📤 Publishing to beehiiv...')
  console.log(`   Title: ${title}`)
  console.log(`   Status: ${body.status}`)
  if (options.subtitle) console.log(`   Subtitle: ${options.subtitle}`)
  if (options.thumbnailUrl) console.log(`   Thumbnail: ${options.thumbnailUrl}`)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BEEHIIV_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`beehiiv API error (${response.status}): ${error}`)
  }

  const result = await response.json()
  return result
}

// Main execution
async function main() {
  const args = process.argv.slice(2)
  const newsletterFile = args[0]
  const shouldPublish = args.includes('--publish')
  const forceFlag = args.includes('--force')

  if (!newsletterFile) {
    console.error('❌ Usage: tsx scripts/publish-to-beehiiv.ts <newsletter-file> [--publish] [--force]')
    console.error('   Example: tsx scripts/publish-to-beehiiv.ts ~/.claudia/wings/creations/newsletter-01.md')
    console.error('   Use --force to republish even if already published (creates duplicate)')
    process.exit(1)
  }

  const filePath = resolve(newsletterFile)
  const metaFilePath = filePath.replace(/\.md$/, '.beehiiv.json')

  console.log(`📖 Reading newsletter from: ${filePath}`)

  // Check if already published
  if (existsSync(metaFilePath) && !forceFlag) {
    const meta = JSON.parse(readFileSync(metaFilePath, 'utf-8'))
    console.error('⚠️  This newsletter has already been published!')
    console.error(`   Post ID: ${meta.postId}`)
    console.error(`   Published: ${meta.publishedAt}`)
    console.error(`   Status: ${meta.status}`)
    console.error('')
    console.error('   To republish anyway (creates duplicate), use --force flag')
    console.error('   Note: beehiiv API v2 does not currently support updating posts')
    console.error('   You may want to edit the post directly in the beehiiv dashboard instead')
    process.exit(1)
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const { metadata, html } = parseMarkdownNewsletter(content)

    const result = await publishToBeehiiv(metadata.title, html, {
      subtitle: metadata.subtitle,
      publish: shouldPublish
    })

    const postId = result.data?.id || 'unknown'

    console.log('✅ Successfully published to beehiiv!')
    console.log(`   Post ID: ${postId}`)
    console.log(`   Status: ${shouldPublish ? 'Published' : 'Draft'}`)
    console.log(`   View at: https://www.iamclaudia.ai`)

    // Save metadata to prevent duplicate publishing
    const meta = {
      postId,
      title: metadata.title,
      subtitle: metadata.subtitle,
      status: shouldPublish ? 'published' : 'draft',
      publishedAt: new Date().toISOString(),
      newsletterFile: basename(filePath)
    }

    writeFileSync(metaFilePath, JSON.stringify(meta, null, 2))
    console.log(`\n💾 Metadata saved to: ${basename(metaFilePath)}`)
    console.log('   (This prevents accidental duplicate publishing)')

  } catch (error) {
    console.error('❌ Failed to publish:', error)
    process.exit(1)
  }
}

main()
