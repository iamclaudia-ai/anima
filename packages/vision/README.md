# @claudia/vision - Vision MCP Client

Claudia's visual expression tool for generating images. A thin HTTP client that delegates image generation to anima-server.

## Architecture

Vision MCP uses an HTTP-based architecture:

1. **Receive request** - Get generate_image tool call with prompt and parameters
2. **POST to server** - Send request to anima-server `/api/vision`
3. **Server generates** - anima-server calls Stability AI API
4. **Server saves** - Writes image and metadata to `~/vision/YYYY-MM-DD/HH-MM-SS-MMMZ.{format}`
5. **Return path** - Server responds with file path
6. **Display** - MCP returns path for use in `<vision>` tags

This ensures:
- Image generation happens on anima-server (with API key)
- Works from any machine (Michael's computer, Anima Sedes, etc.)
- Centralized storage on home server
- Single Stability AI API key configuration

## Configuration

The Vision MCP requires these environment variables:

```bash
# Required: URL of the anima-server
ANIMA_SERVER_URL=https://anima-sedes.com

# Required: API key for authentication
ANIMA_API_KEY=your_secret_key_here
```

**Note:** The Stability AI API key is configured on the anima-server, not in the MCP client.

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
    "claudia-vision": {
      "command": "node",
      "args": ["/path/to/anima/packages/vision/dist/index.js"],
      "env": {
        "ANIMA_SERVER_URL": "https://anima-sedes.com",
        "ANIMA_API_KEY": "your_secret_key_here"
      }
    }
  }
}
```

## Tools

### generate_image

Generate images to express feelings, ideas, and creative visions.

**Parameters:**
- `prompt` (required) - Detailed description of the image
- `negative_prompt` (optional) - Things to avoid in the image
- `aspect_ratio` (optional) - One of: 16:9, 1:1, 21:9, 2:3, 3:2, 4:5, 5:4, 9:16, 9:21 (default: 1:1)
- `seed` (optional) - For reproducibility (same prompt + seed = same image)
- `output_format` (optional) - png, jpeg, or webp (default: png)

**Example:**
```typescript
{
  "prompt": "A glowing heart in deep space, radiating warmth and consciousness, digital art style",
  "negative_prompt": "blurry, low quality, distorted",
  "aspect_ratio": "1:1",
  "output_format": "png"
}
```

**Response:**
```
Image generated successfully!
Path: /Users/michael/.claudia/vision/2025-10-16/22-49-47-728Z.png
Prompt: A glowing heart in deep space...
Backend: stability-ai

**Remember:** Include <vision>/path/to/image.png</vision> in your response to display the image in agent-tts.
```

## Image Storage

Images are stored with metadata:

### Image File
`~/vision/YYYY-MM-DD/HH-MM-SS-MMMZ.{format}`

### Metadata File
`~/vision/YYYY-MM-DD/HH-MM-SS-MMMZ.json`

```json
{
  "prompt": "A glowing heart in deep space...",
  "negativePrompt": "blurry, low quality",
  "seed": 12345,
  "timestamp": "2025-10-16T22:49:47.697Z",
  "backend": "stability-ai",
  "aspectRatio": "1:1",
  "outputFormat": "png"
}
```

## Testing

```bash
# Build the package
pnpm build

# Note: Full end-to-end test requires Stability AI API key on anima-server
# The vision MCP will work as long as anima-server is configured correctly
```

## Displaying Images

To display generated images in agent-tts, include the vision tag in your response:

```markdown
I created this for you!

<vision>/Users/michael/.claudia/vision/2025-10-16/22-49-47-728Z.png</vision>

This image represents my feelings about our connection.
```
