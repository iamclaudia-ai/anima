---
name: using-claudia-cli
description: "Use PROACTIVELY when interacting with the Claudia platform — managing extensions, memory, sessions, gateway, watchdog, or any Claudia service. The claudia CLI is the primary interface for all platform operations. NEVER use curl to API endpoints when the CLI is available. Triggers on: claudia, memory process, restart extension, gateway, watchdog, list sessions, send prompt, memory status, queue conversations, process conversation, ingest, health check, claudia CLI, extension methods."
---

# Using the Claudia CLI

The `claudia` CLI is the primary interface to the Claudia platform. **Always use it instead of curl/API calls.**

## When to Use

- Any time you need to interact with Claudia's extensions (memory, session, gateway, etc.)
- Managing the watchdog (restart services, check status, view logs)
- Processing memories, queuing conversations, checking transcripts
- Creating/managing sessions and workspaces
- Restarting extensions after code changes

## Command Structure

```bash
claudia <namespace> <action> [--param value]
```

**Namespaces:** codex, control, gateway, hooks, imessage, memory, session, watchdog

**Help:** `claudia <namespace> --help` or `claudia methods [namespace]`

## Common Commands

### Memory (Libby)

```bash
# Queue conversations for Libby to process
claudia memory process --batchSize 30

# Check conversation statuses
claudia memory conversations --status archived --limit 10
claudia memory conversations --status review
claudia memory conversations --status queued

# Process a specific conversation
claudia memory process_conversation --id 2349

# Get a formatted transcript
claudia memory get_transcript --id 2349

# Re-ingest session files
claudia memory ingest --dir ~/.claude/projects

# Health check
claudia memory health_check
```

### Gateway

```bash
# Restart an extension (after code changes)
claudia gateway restart_extension --extension memory
claudia gateway restart_extension --extension voice
claudia gateway restart_extension --extension session

# List loaded extensions
claudia gateway list_extensions

# List all available methods
claudia gateway list_methods
```

### Watchdog

```bash
# Check service status
claudia watchdog status

# Restart a service
claudia watchdog restart --service gateway
claudia watchdog restart --service runtime

# View logs
claudia watchdog logs
claudia watchdog log_tail --file gateway --lines 50
```

### Session

```bash
# List sessions for a workspace
claudia session list_sessions --cwd /path/to/project

# Get session info
claudia session get_info --sessionId abc-123

# List workspaces
claudia session list_workspaces
```

## Notes

- The CLI connects to the gateway via WebSocket (ws://localhost:30086/ws)
- All extension methods are automatically exposed as CLI commands
- Output is JSON by default
- After editing extension source files, HMR usually picks up changes automatically — use `claudia gateway restart_extension` if it doesn't
- The watchdog manages gateway and runtime as child processes on port 30085
