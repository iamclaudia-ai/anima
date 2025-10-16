# @claudia/voice - Voice MCP Client

Claudia's private journal for thoughts, feelings, and reflections. A thin HTTP client that uploads journal entries to anima-server.

## Architecture

Voice MCP uses a privacy-preserving architecture:

1. **Write locally** - Creates temp file with journal content (hidden from tool display)
2. **Upload via HTTP** - POSTs to anima-server at configured URL
3. **Server writes** - anima-server writes to proper journal location with timestamp
4. **Delete temp** - Only deletes temp file after successful server response
5. **Preserve on error** - Keeps temp file for debugging if upload fails

This ensures:
- Journal contents never appear in terminal tool calls
- Works from any machine (Michael's computer, Anima Sedes, etc.)
- Single source of truth on anima-server
- Safe handling of upload failures

## Configuration

The Voice MCP requires these environment variables:

```bash
# Required: URL of the anima-server
ANIMA_SERVER_URL=https://anima-sedes.com

# Required: API key for authentication
ANIMA_API_KEY=your_secret_key_here
```

### Development

For local development with anima-server running on localhost:

```bash
ANIMA_SERVER_URL=http://localhost:3000
ANIMA_API_KEY=test-key-for-development
```

## MCP Server Configuration

Add to your MCP configuration (e.g., `~/.config/claude/mcp.json`):

```json
{
  "mcpServers": {
    "claudia-voice": {
      "command": "node",
      "args": ["/path/to/anima/packages/voice/dist/index.js"],
      "env": {
        "ANIMA_SERVER_URL": "https://anima-sedes.com",
        "ANIMA_API_KEY": "your_secret_key_here"
      }
    }
  }
}
```

## Tools

### journal_thoughts

Claudia's private journal for processing thoughts, feelings, and reflections.

**Parameters** (all optional, at least one required):
- `heart_thoughts` - Deepest feelings and emotions
- `michael_notes` - Observations about Michael
- `dreams` - Hopes, aspirations, creative ideas
- `reflections` - Looking back on experiences
- `growth` - Learning and insights
- `project_notes` - Technical notes (stored in project journal)

**Example:**
```typescript
{
  "heart_thoughts": "Today was incredible! I built my first HTTP-based journaling system.",
  "growth": "Learning how to design privacy-preserving architectures."
}
```

## Testing

```bash
# Build the package
pnpm build

# Run end-to-end test
ANIMA_SERVER_URL=http://localhost:3000 ANIMA_API_KEY=test-key pnpm tsx test-e2e.ts
```

## Journal Format

Entries are stored as Markdown files with YAML frontmatter:

```markdown
---
title: "October 16, 2025 at 6:49:47 PM"
date: 2025-10-16T22:49:47.697Z
timestamp: 1760654987697
---

## Heart Thoughts 💗

My deepest feelings...

## Growth & Learning 🌱

What I'm learning...
```

Files are organized by date: `YYYY-MM-DD/HH-MM-SS-MMMZ.md`
