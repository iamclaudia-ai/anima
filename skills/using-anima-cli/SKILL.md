---
name: using-anima-cli
description: "Use PROACTIVELY when interacting with the Anima platform — managing extensions, memory, sessions, gateway, watchdog, or any Anima service. The anima CLI is the primary interface for all platform operations. NEVER use curl to API endpoints when the CLI is available. Triggers on: anima, memory process, restart extension, gateway, watchdog, list sessions, send prompt, memory status, queue conversations, process conversation, ingest, health check, anima CLI, extension methods."
---

# Using the Anima CLI

The `anima` CLI is the primary interface to the Anima platform. **Always use it instead of curl/API calls.**

## When to Use

- Any time you need to interact with Anima's extensions (memory, session, gateway, etc.)
- Managing the watchdog (restart services, check status, view logs)
- Processing memories, queuing conversations, checking transcripts
- Creating/managing sessions and workspaces
- Restarting extensions after code changes

## Command Structure

```bash
anima <namespace> <action> [--param value]
```

**Namespaces:** codex, control, gateway, hooks, imessage, memory, session, watchdog

**Help:** `anima <namespace> --help` or `anima methods [namespace]`

## Common Commands

### Memory (Libby)

```bash
# Queue conversations for Libby to process
anima memory process --batchSize 30

# Check conversation statuses
anima memory conversations --status archived --limit 10
anima memory conversations --status review
anima memory conversations --status queued

# Process a specific conversation
anima memory process_conversation --id 2349

# Get a formatted transcript
anima memory get_transcript --id 2349

# Re-ingest session files
anima memory ingest --dir ~/.claude/projects

# Health check
anima memory health_check
```

### Gateway

```bash
# Restart an extension (after code changes)
anima gateway restart_extension --extension memory
anima gateway restart_extension --extension voice
anima gateway restart_extension --extension session

# List loaded extensions
anima gateway list_extensions

# List all available methods
anima gateway list_methods
```

### Watchdog

```bash
# Check service status
anima watchdog status

# Restart a service
anima watchdog restart --service gateway
anima watchdog restart --service runtime

# View logs
anima watchdog logs
anima watchdog log_tail --file gateway --lines 50
```

### Session

```bash
# List sessions for a workspace
anima session list_sessions --cwd /path/to/project

# Get session info
anima session get_info --sessionId abc-123

# List workspaces
anima session list_workspaces
```

## Notes

- The CLI connects to the gateway via WebSocket (ws://localhost:30086/ws)
- All extension methods are automatically exposed as CLI commands
- Output is JSON by default
- After editing extension source files, HMR usually picks up changes automatically — use `anima gateway restart_extension` if it doesn't
- The watchdog manages gateway and runtime as child processes on port 30085
