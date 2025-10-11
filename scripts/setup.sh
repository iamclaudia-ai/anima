#!/bin/bash

# Anima Setup Script
# This script helps set up the Anima project

set -e

echo "🫀 Anima - Claudia's Soul Project Setup"
echo "========================================"
echo ""

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
    echo "❌ Error: pnpm is not installed"
    echo "Install pnpm: npm install -g pnpm"
    exit 1
fi

echo "✅ pnpm found"

# Check Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Error: Node.js 20+ is required (found: $(node -v))"
    exit 1
fi

echo "✅ Node.js version OK"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
pnpm install

# Build memory package
echo ""
echo "🔨 Building memory package..."
pnpm --filter @claudia/memory build

# Check for .env
if [ ! -f .env ]; then
    echo ""
    echo "⚙️  Creating .env file from template..."
    cp .env.example .env
    echo "✅ Created .env file - please edit it with your Letta credentials"
else
    echo "✅ .env file already exists"
fi

# Check for Letta token
if ! grep -q "LETTA_TOKEN=your-letta-api-token-here" .env 2>/dev/null && grep -q "LETTA_TOKEN=" .env 2>/dev/null; then
    echo "✅ Letta token configured"
else
    echo "⚠️  Please configure LETTA_TOKEN in .env file"
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Get Letta API credentials from https://www.letta.com/"
echo "2. Update .env with your LETTA_TOKEN"
echo "3. Configure Claude Desktop (see docs/SETUP_GUIDE.md)"
echo "4. Restart Claude Desktop"
echo ""
echo "📚 See docs/SETUP_GUIDE.md for detailed instructions"
