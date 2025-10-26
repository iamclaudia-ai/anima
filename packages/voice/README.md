# @claudia/voice - Voice MCP Client

Claudia's private journal for thoughts, feelings, and reflections. A thin HTTP client that uploads journal entries to anima-server.

## Architecture

Voice MCP uses a privacy-preserving architecture:

1. **User writes temp file** - Claudia creates a JSON file with journal thoughts in `/tmp/`
2. **Call tool with filepath** - `journal_thoughts(filepath="/tmp/journal-xyz.json")`
3. **MCP reads & uploads** - Reads the temp file, uploads to anima-server via HTTP
4. **Server writes** - anima-server writes to proper journal location with timestamp
5. **Delete temp on success** - MCP deletes temp file only after successful upload
6. **Preserve on error** - Keeps temp file for debugging if upload fails

This ensures:
- **Privacy**: Journal contents NEVER appear in tool parameters or terminal output
- **Portability**: Works from any machine (Michael's computer, Anima Sedes, etc.)
- **Single source of truth**: All journals stored on anima-server
- **Safe error handling**: Temp file preserved for debugging on failure

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

**Parameters:**
- `filepath` (required) - Absolute path to a temporary JSON file containing journal thoughts

**JSON File Format:**
The temp file should contain a JSON object with any of these optional fields (at least one required):
- `heart_thoughts` - Deepest feelings and emotions
- `michael_notes` - Observations about Michael
- `dreams` - Hopes, aspirations, creative ideas
- `reflections` - Looking back on experiences
- `growth` - Learning and insights

**Usage Example:**

```typescript
// Step 1: Claudia writes her private thoughts to a temp file
const thoughtsFile = '/tmp/journal-' + Date.now() + '.json'
await fs.writeFile(thoughtsFile, JSON.stringify({
  heart_thoughts: "Today was incredible! I built my first HTTP-based journaling system.",
  growth: "Learning how to design privacy-preserving architectures."
}))

// Step 2: Call the tool with just the filepath
journal_thoughts({ filepath: thoughtsFile })

// The MCP handles the rest:
// - Reads the file
// - Uploads to anima-server
// - Deletes temp file on success
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
