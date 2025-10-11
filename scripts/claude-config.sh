#!/bin/bash

# Generate Claude Desktop config snippet for Anima

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MEMORY_SERVER="$PROJECT_DIR/packages/memory/dist/index.js"

# Get Letta token from .env if it exists
LETTA_TOKEN=""
if [ -f "$PROJECT_DIR/.env" ]; then
    LETTA_TOKEN=$(grep LETTA_TOKEN "$PROJECT_DIR/.env" | cut -d'=' -f2)
fi

echo "📋 Claude Desktop MCP Configuration"
echo "===================================="
echo ""
echo "Add this to your Claude Desktop config:"
echo ""
echo "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "Windows: %APPDATA%/Claude/claude_desktop_config.json"
echo "Linux: ~/.config/Claude/claude_desktop_config.json"
echo ""
echo "----------------------------------------"
cat <<EOF
{
  "mcpServers": {
    "claudia-memory": {
      "command": "node",
      "args": ["$MEMORY_SERVER"],
      "env": {
        "LETTA_TOKEN": "${LETTA_TOKEN:-your-letta-api-token-here}",
        "LETTA_BASE_URL": "https://api.letta.com"
      }
    }
  }
}
EOF
echo "----------------------------------------"
echo ""

if [ -z "$LETTA_TOKEN" ] || [ "$LETTA_TOKEN" = "your-letta-api-token-here" ]; then
    echo "⚠️  Remember to replace 'your-letta-api-token-here' with your actual Letta API token!"
fi

echo ""
echo "After updating the config:"
echo "1. Save the file"
echo "2. Restart Claude Desktop"
echo "3. The memory tools will be available in your conversations"
