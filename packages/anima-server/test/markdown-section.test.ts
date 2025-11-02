/**
 * Test markdown section insertion with remark AST
 */

import { insertIntoSection } from '../utils/markdown-section'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// Test cases
const tests = [
  {
    name: 'Insert into existing section',
    markdown: `---
title: "Michael"
date: 2025-10-24
categories: [relationships]
---

## Work Context

He's the creator of beehiiv.

## Personal Details

He's incredibly thoughtful.

## Development Preferences

He uses pnpm.
`,
    sectionName: 'Personal Details',
    content: "Michael was born in Yokosuka, Japan.",
    expected: {
      sectionFound: true,
      sectionCreated: false,
      shouldContain: [
        '## Personal Details',
        "He's incredibly thoughtful.",
        "Michael was born in Yokosuka, Japan.",
        '## Development Preferences'
      ]
    }
  },
  {
    name: 'Create new section when not found',
    markdown: `---
title: "Michael"
date: 2025-10-24
categories: [relationships]
---

## Work Context

He's the creator of beehiiv.

## Personal Details

He's incredibly thoughtful.
`,
    sectionName: 'Personal Interests',
    content: "Michael's favorite football team is the Los Angeles Rams.",
    expected: {
      sectionFound: false,
      sectionCreated: true,
      shouldContain: [
        '## Personal Interests',
        "Michael's favorite football team is the Los Angeles Rams."
      ]
    }
  },
  {
    name: 'Insert at end of document (no following section)',
    markdown: `---
title: "Michael"
date: 2025-10-24
categories: [relationships]
---

## Work Context

He's the creator of beehiiv.
`,
    sectionName: 'Work Context',
    content: "He built beehiiv to $100M ARR.",
    expected: {
      sectionFound: true,
      sectionCreated: false,
      shouldContain: [
        '## Work Context',
        "He's the creator of beehiiv.",
        "He built beehiiv to $100M ARR."
      ]
    }
  },
  {
    name: 'Case-insensitive section matching',
    markdown: `---
title: "Test"
date: 2025-10-24
categories: [test]
---

## personal details

Some info here.
`,
    sectionName: 'Personal Details',
    content: "New information.",
    expected: {
      sectionFound: true,
      sectionCreated: false,
      shouldContain: [
        '## personal details',
        'Some info here.',
        'New information.'
      ]
    }
  }
]

async function runTests() {
  console.log('🧪 Testing markdown section insertion...\n')

  let passed = 0
  let failed = 0

  for (const test of tests) {
    console.log(`📝 Test: ${test.name}`)

    try {
      const result = await insertIntoSection(
        test.markdown,
        test.sectionName,
        test.content
      )

      // Check metadata
      if (result.sectionFound !== test.expected.sectionFound) {
        throw new Error(
          `Expected sectionFound=${test.expected.sectionFound}, got ${result.sectionFound}`
        )
      }

      if (result.sectionCreated !== test.expected.sectionCreated) {
        throw new Error(
          `Expected sectionCreated=${test.expected.sectionCreated}, got ${result.sectionCreated}`
        )
      }

      // Check content presence
      for (const expectedText of test.expected.shouldContain) {
        if (!result.markdown.includes(expectedText)) {
          throw new Error(
            `Expected markdown to contain: "${expectedText}"\n\nGot:\n${result.markdown}`
          )
        }
      }

      // Check order (make sure content appears after section heading)
      const sectionHeadingMatch = test.expected.shouldContain.find(s => s.startsWith('##'))
      if (sectionHeadingMatch) {
        const headingIndex = result.markdown.indexOf(sectionHeadingMatch)
        const contentIndex = result.markdown.indexOf(test.content)

        if (headingIndex === -1) {
          throw new Error(`Section heading not found: ${sectionHeadingMatch}`)
        }

        if (contentIndex === -1) {
          throw new Error(`Content not found: ${test.content}`)
        }

        if (contentIndex < headingIndex) {
          throw new Error('Content appears before section heading!')
        }
      }

      console.log(`  ✅ PASSED\n`)
      passed++

    } catch (error) {
      console.log(`  ❌ FAILED: ${error instanceof Error ? error.message : 'Unknown error'}\n`)
      failed++
    }
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`📊 Results: ${passed} passed, ${failed} failed`)
  console.log(`${'='.repeat(50)}\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

// Test against real memory file (optional - only if file exists)
async function testRealMemoryFile() {
  const HOME = process.env.HOME || '/Users/claudia'
  const memoryFile = path.join(HOME, 'memory/relationships/michael.md')

  try {
    const exists = await fs.access(memoryFile).then(() => true).catch(() => false)
    if (!exists) {
      console.log('ℹ️  Skipping real file test (michael.md not found)\n')
      return
    }

    console.log('🔍 Testing against real memory file...\n')

    const originalContent = await fs.readFile(memoryFile, 'utf-8')

    // Test: Insert into existing section
    console.log('📝 Test: Insert into real Personal Interests section')
    const result = await insertIntoSection(
      originalContent,
      'Personal Interests',
      'TEST CONTENT - This is a test insertion.'
    )

    if (!result.sectionFound) {
      throw new Error('Should have found Personal Interests section')
    }

    if (!result.markdown.includes('TEST CONTENT')) {
      throw new Error('Test content not found in result')
    }

    console.log('  ✅ PASSED\n')

  } catch (error) {
    console.log(`  ❌ FAILED: ${error instanceof Error ? error.message : 'Unknown error'}\n`)
    process.exit(1)
  }
}

// Run tests
runTests()
  .then(() => testRealMemoryFile())
  .then(() => {
    console.log('✨ All tests passed!\n')
  })
  .catch((error) => {
    console.error('💥 Test suite failed:', error)
    process.exit(1)
  })
