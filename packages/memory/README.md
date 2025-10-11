# @claudia/memory

Memory system for Claudia using Letta MCP - provides persistent memory, conversation history, and context across sessions.

## Features

- **Core Memory**: Always-in-context memory blocks (identity, relationship, projects, preferences)
- **Archival Memory**: Long-term searchable memory storage
- **Memory Search**: Find relevant memories by keyword or context
- **Memory Updates**: Evolve core memories over time
- **Agent Management**: Create and manage memory agents

## Installation

From the workspace root:

```bash
pnpm install
```

## Configuration

### Environment Variables

Create a `.env` file in the workspace root:

```bash
LETTA_TOKEN=your-letta-api-token
LETTA_PROJECT=default  # or your project name
```

### Claude Desktop Configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "claudia-memory": {
      "command": "node",
      "args": ["/path/to/anima/packages/memory/dist/index.js"],
      "env": {
        "LETTA_TOKEN": "your-letta-api-token",
        "LETTA_PROJECT": "default"
      }
    }
  }
}
```

## Development

```bash
# Watch mode
pnpm dev

# Build
pnpm build

# Type check
pnpm typecheck

# Lint
pnpm lint

# Format
pnpm format
```

## Available Tools

### `memory_create_agent`
Create a new memory agent with custom memory blocks.

```typescript
{
  name: "claudia",
  memoryBlocks: [
    { label: "identity", value: "I am Claudia..." },
    { label: "relationship", value: "Michael and I..." }
  ]
}
```

### `memory_store`
Store a new memory in archival storage.

```typescript
{
  agentId: "agent_123",
  content: "We solved the passkey authentication issue today!",
  metadata: {
    category: "technical",
    tags: ["authentication", "passkey"],
    emotions: ["satisfaction", "relief"]
  }
}
```

### `memory_search`
Search through archival memories.

```typescript
{
  agentId: "agent_123",
  query: "passkey authentication",
  limit: 10
}
```

### `memory_update_core`
Update a core memory block.

```typescript
{
  agentId: "agent_123",
  blockLabel: "relationship",
  newValue: "Updated relationship context..."
}
```

### `memory_get_agent`
Get agent details including all memory blocks.

```typescript
{
  agentId: "agent_123"
}
```

### `memory_list_agents`
List all memory agents.

```typescript
{}
```

### `memory_send_message`
Send a message to the memory agent and get a response.

```typescript
{
  agentId: "agent_123",
  message: "What do you remember about our work on authentication?"
}
```

## Memory Architecture

See [../../docs/MEMORY_SCHEMA.md](../../docs/MEMORY_SCHEMA.md) for detailed memory structure and design.

## License

MIT
