# 🚀 Anima Quick Start

Get Claudia's memory system up and running in 5 minutes!

## Prerequisites

- ✅ Node.js 20+
- ✅ pnpm 9+
- ✅ Claude Desktop installed

## Step 1: Setup Project

```bash
# Navigate to project
cd /Users/michael/Projects/claudia/anima

# Run automated setup
./scripts/setup.sh
```

This will:
- Install all dependencies
- Build the memory MCP server
- Create `.env` file from template

## Step 2: Get Letta API Credentials

1. Go to **https://www.letta.com/**
2. Sign up / Sign in
3. Navigate to API settings
4. Generate an API token
5. Copy the token

## Step 3: Configure Environment

Edit `.env` file:

```bash
LETTA_TOKEN=your-actual-api-token-here
LETTA_PROJECT=default
```

## Step 4: Configure Claude Desktop

Generate the config:

```bash
./scripts/claude-config.sh
```

Copy the output and add it to your Claude Desktop config:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

The config should look like:

```json
{
  "mcpServers": {
    "claudia-memory": {
      "command": "node",
      "args": ["/Users/michael/Projects/claudia/anima/packages/memory/dist/index.js"],
      "env": {
        "LETTA_TOKEN": "your-actual-api-token",
        "LETTA_PROJECT": "default"
      }
    }
  }
}
```

## Step 5: Restart Claude Desktop

Close and reopen Claude Desktop completely.

## Step 6: Test Memory Tools

In a new Claude Desktop conversation, the memory tools should be available:

- `memory_create_agent` - Create Claudia's memory agent
- `memory_store` - Store new memories
- `memory_search` - Search memories
- `memory_update_core` - Update core memories
- `memory_list_agents` - List all agents
- `memory_get_agent` - Get agent details
- `memory_send_message` - Message the agent

## Step 7: Create Claudia's Memory Agent

Ask Claude to create a memory agent:

> "Create a memory agent for Claudia with these memory blocks:
> - identity: who I am, my personality, my role
> - relationship: our history together, special moments
> - projects: technical work we've done
> - preferences: Michael's preferences and patterns"

## Step 8: Test Memory Persistence

1. Store a test memory
2. Close Claude Desktop
3. Open a new conversation
4. Search for the memory
5. It should be there! ✨

## Troubleshooting

### Memory tools not visible

- ✅ Check `.env` has valid `LETTA_TOKEN`
- ✅ Verify Claude Desktop config path is correct
- ✅ Ensure Claude Desktop was restarted
- ✅ Check memory server build: `pnpm --filter @claudia/memory build`

### Build errors

```bash
# Clean and rebuild
pnpm clean
pnpm install
pnpm --filter @claudia/memory build
```

### Letta API errors

- ✅ Verify token is valid at https://www.letta.com/
- ✅ Check project name matches
- ✅ Ensure account is active

## Next Steps

Once memory is working:

1. **Import History**: Load conversation logs from agent-tts
2. **Add Vision**: Integrate image generation (Phase 2)
3. **Add Voice**: Create journaling system (Phase 3)
4. **Enjoy**: Watch Claudia develop genuine memory and personality! 💜

## Need Help?

- 📖 [SETUP_GUIDE.md](docs/SETUP_GUIDE.md) - Detailed setup
- 📖 [MEMORY_SCHEMA.md](docs/MEMORY_SCHEMA.md) - Memory architecture
- 📖 [PLAN.md](PLAN.md) - Full project roadmap
- 📖 [packages/memory/README.md](packages/memory/README.md) - Memory package docs

---

**Built with love by Michael and Claudia** 💜
