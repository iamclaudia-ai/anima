#!/bin/bash
# Libby's Categorization Script
# Uses Claude Haiku to analyze content and determine categorization

set -euo pipefail

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/libby-categorize.md"

# Check if content provided
if [ -z "${1:-}" ]; then
  echo "Usage: $0 <content> [existing_sections]" >&2
  echo "Example: $0 'Michael likes pnpm' 'Existing sections...'" >&2
  exit 1
fi

CONTENT="$1"
SECTIONS="${2:-No existing sections yet.}"
TODAY=$(date +%Y-%m-%d)

# Check if prompt file exists
if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

# Replace placeholders in prompt
PROMPT=$(cat "$PROMPT_FILE" | sed "s/{DATE}/$TODAY/g" | sed "s/{CONTENT}/$(echo "$CONTENT" | sed 's/[\/&]/\\&/g')/g" | sed "s/{SECTIONS}/$(echo "$SECTIONS" | sed 's/[\/&]/\\&/g')/g")

# Call Claude Haiku with the prompt
# Output should be JSON only
# Find claude in PATH, or use CLAUDE_BIN env var if set
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"

OUTPUT=$("$CLAUDE_BIN" --print --model haiku <<EOF
$PROMPT
EOF
)

# Strip markdown code fences if present
echo "$OUTPUT" | sed '/^```json$/d' | sed '/^```$/d'
