/**
 * Markdown section manipulation using remark AST
 *
 * Safely inserts content into markdown sections without brittle string manipulation.
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import type { Root, Heading, Content } from 'mdast'

export interface SectionInsertResult {
  markdown: string
  sectionCreated: boolean
  sectionFound: boolean
}

/**
 * Insert content into a specific section of a markdown document
 *
 * @param markdown - The full markdown content
 * @param sectionName - The heading text to find (case-insensitive)
 * @param content - The content to insert (plain text, will be wrapped in paragraph)
 * @returns Result with modified markdown and metadata
 */
export async function insertIntoSection(
  markdown: string,
  sectionName: string,
  content: string
): Promise<SectionInsertResult> {
  // Parse markdown into AST
  const tree = unified()
    .use(remarkParse)
    .parse(markdown) as Root

  // Find the target section heading
  let sectionFound = false
  let sectionIndex = -1
  let sectionDepth = 0

  visit(tree, 'heading', (node: Heading, index, parent) => {
    if (!parent || sectionFound) return

    // Check if this heading matches our target (case-insensitive)
    const headingText = extractHeadingText(node)
    if (headingText.toLowerCase() === sectionName.toLowerCase()) {
      sectionFound = true
      sectionIndex = index!
      sectionDepth = node.depth
    }
  })

  if (sectionFound && sectionIndex >= 0) {
    // Found the section - insert content after it
    // We need to find where this section ends (next same/higher-level heading or end)
    const nextHeadingIndex = findNextHeadingIndex(tree, sectionIndex, sectionDepth)

    // Create paragraph node for the content
    const paragraphNode: Content = {
      type: 'paragraph',
      children: [{ type: 'text', value: content }]
    }

    // Insert before the next heading (or at end if no next heading)
    tree.children.splice(nextHeadingIndex, 0, paragraphNode)

    const result = await serializeMarkdown(tree)
    return {
      markdown: result,
      sectionCreated: false,
      sectionFound: true
    }
  } else {
    // Section not found - append it at the end
    const headingNode: Heading = {
      type: 'heading',
      depth: 2,
      children: [{ type: 'text', value: sectionName }]
    }

    const paragraphNode: Content = {
      type: 'paragraph',
      children: [{ type: 'text', value: content }]
    }

    // Add heading and content at the end
    tree.children.push(headingNode, paragraphNode)

    const result = await serializeMarkdown(tree)
    return {
      markdown: result,
      sectionCreated: true,
      sectionFound: false
    }
  }
}

/**
 * Check if a section exists in markdown
 *
 * @param markdown - The markdown content to check
 * @param sectionName - The section heading to find (case-insensitive)
 * @returns true if section exists, false otherwise
 */
export function sectionExists(markdown: string, sectionName: string): boolean {
  const tree = unified()
    .use(remarkParse)
    .parse(markdown) as Root

  let found = false

  visit(tree, 'heading', (node: Heading) => {
    if (found) return
    const headingText = extractHeadingText(node)
    if (headingText.toLowerCase() === sectionName.toLowerCase()) {
      found = true
    }
  })

  return found
}

/**
 * Extract text from heading node
 */
function extractHeadingText(heading: Heading): string {
  return heading.children
    .filter(child => child.type === 'text')
    .map(child => (child as any).value)
    .join('')
}

/**
 * Find the index where the next same-or-higher level heading starts
 * Returns the index to insert content before
 */
function findNextHeadingIndex(tree: Root, currentIndex: number, currentDepth: number): number {
  for (let i = currentIndex + 1; i < tree.children.length; i++) {
    const node = tree.children[i]
    if (node.type === 'heading' && node.depth <= currentDepth) {
      return i
    }
  }
  // No next heading found - insert at end
  return tree.children.length
}

/**
 * Serialize AST back to markdown
 */
async function serializeMarkdown(tree: Root): Promise<string> {
  const file = await unified()
    .use(remarkStringify, {
      bullet: '-',
      emphasis: '_',
      strong: '*',
      rule: '-'
    })
    .stringify(tree)

  return String(file)
}
