# Claudia

<div style="text-align: center; background-color: #fff; padding: 16px; margin-bottom: 16px;">
  <img src="./assets/claudia.png" alt="Claudia" style="width: 350px; height: 350px;"/>
</div>

A personal AI assistant platform built around Claude Code CLI. One gateway, one port, every interface.

## What is Claudia?

Claudia is a gateway-centric platform for interacting with Claude through any interface you want — web browser, CLI, iOS, macOS menubar, VS Code, iMessage, and voice. Instead of wrapping the CLI for remote control, Claudia's gateway **is** the control plane. Sessions can be created from any client, anywhere.

**Ports:**

- **30086** — Gateway (SHA256("Claudia") = `7586...`)
- **30087** — Agent Host (SDK process isolation)

```
┌──────────────────────────────────────────────────────────┐
│                Watchdog (port 30085)                     │
│                                                          │
│  ┌────────────────────┐  ┌──────────────────────────┐   │
│  │   Agent Host       │  │   Gateway (30086)        │   │
│  │   (port 30087)     │  │                          │   │
│  │                    │  │  Bun.serve:              │   │
│  │  SDK Sessions:     │  │    /ws  → WebSocket      │   │
│  │  ├─ Claude query() │  │    /*   → Web UI         │   │
│  │  └─ Codex Thread   │  │                          │   │
│  │                    │  │  Extensions (NDJSON):    │   │
│  │  Ring buffers for  │  │  ├─ session ──┐          │   │
│  │  reconnection      │  │  ├─ voice     │          │   │
│  └─────────▲──────────┘  │  └─ chat      │          │   │
│            │             └────────────────┼──────────┘   │
│            │ WebSocket                    │              │
│            └──────────────────────────────┘              │
└──────────────────────────────────────────────────────────┘
                   │ WebSocket (ws://localhost:30086/ws)
              ┌────┼─────────┬──────────┬──────────┐
              │    │         │          │          │
           ┌──┴──┐ ┌──┴──┐ ┌──┴──┐ ┌───┴───┐ ┌───┴───┐
           │ Web │ │ CLI │ │ 💋  │ │  iOS  │ │VS Code│
           │ UI  │ │     │ │Menu │ │  App  │ │  ext  │
           └─────┘ └─────┘ └─────┘ └───────┘ └───────┘
```

**Process Architecture:**

- **Watchdog** manages gateway and agent-host as direct child processes
- **Agent-host** owns all SDK processes (Claude, Codex) and survives restarts
- **Gateway** runs extensions as child processes via NDJSON stdio
- **Extensions** connect to agent-host via WebSocket for SDK operations

## Quick Start

```bash
# Install dependencies
bun install

# Start Claudia (single command — serves web UI + WebSocket + extensions)
bun run dev

# Open http://localhost:30086
```

That's it. One command, one port, everything works.

## Interfaces

| Interface         | Description                                               |
| ----------------- | --------------------------------------------------------- |
| **Web UI**        | Browser-based chat at `http://localhost:30086`            |
| **CLI**           | Schema-driven client with method discovery and validation |
| **iOS App**       | Native Swift voice mode app with streaming audio          |
| **macOS Menubar** | Quick-access menubar app (SwiftUI, icon: 💋)              |
| **VS Code**       | Sidebar chat with workspace auto-discovery                |
| **iMessage**      | Text-based interaction via Messages app                   |
| **Voice**         | Cartesia Sonic 3.0 real-time streaming TTS                |

## Everything is an Extension

Every feature — including the web chat UI — is an extension that plugs into the gateway:

| Extension  | What it does                                           |
| ---------- | ------------------------------------------------------ |
| `chat`     | Web chat pages — workspace list, session list, chat UI |
| `voice`    | Cartesia TTS streaming, auto-speak, audio saving       |
| `imessage` | iMessage bridge, auto-reply to allowed contacts        |
| `control`  | System dashboard with extension health monitoring      |

Extensions provide server methods (RPC over WebSocket), web pages (React components with routes), event handlers, and structured health checks. All methods use schema-driven validation at the gateway boundary.

Server extension code is config-driven and runs out-of-process by default: gateway enumerates enabled extension IDs from `~/.claudia/claudia.json` and spawns one extension-host child per extension, loading `extensions/<id>/src/index.ts`.

## Project Structure

```
claudia/
├── packages/
│   ├── gateway/          # Event bus + extension host
│   ├── agent-host/       # SDK process isolation server (Claude, Codex)
│   ├── watchdog/         # Process supervisor for gateway + agent-host
│   ├── extension-host/   # Generic shim for out-of-process extensions
│   ├── cli/              # Schema-driven CLI with method discovery
│   ├── shared/           # Shared types, config, protocol definitions
│   ├── ui/               # Shared React components + pushState router
│   └── memory-mcp/       # MCP server for persistent memory system
├── clients/
│   ├── ios/              # Native Swift iOS voice mode app
│   ├── menubar/          # macOS menubar app (SwiftUI) 💋
│   └── vscode/           # VS Code extension with sidebar chat
├── extensions/
│   ├── session/          # Session management (thin client to agent-host)
│   ├── chat/             # Web chat pages (workspaces, sessions, chat)
│   ├── voice/            # Cartesia TTS + auto-speak + audio store
│   ├── imessage/         # iMessage bridge + auto-reply
│   └── control/          # System dashboard + health checks
├── skills/               # Claude Code skills (meditation, stories, TTS tools)
└── docs/                 # Architecture, API reference, testing guides
```

## Development

```bash
bun run dev              # Start gateway (serves everything)
bun test                 # Run tests
bun run typecheck        # Type check (canonical)
bun run typecheck:fast   # Fast type check via tsgo (used in pre-commit)
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full guide including git hooks, testing strategy, and workspace conventions.

## Documentation

See the [docs index](./docs/README.md) for a full guide to all documentation, or jump to the highlights:

| Doc                                         | Description                             |
| ------------------------------------------- | --------------------------------------- |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md)   | System architecture (gateway + runtime) |
| [API-REFERENCE.md](./docs/API-REFERENCE.md) | Complete WebSocket API contract         |
| [GATEWAY.md](./docs/GATEWAY.md)             | Gateway internals and event routing     |
| [EXTENSIONS.md](./docs/EXTENSIONS.md)       | Extension system and authoring guide    |
| [DEVELOPMENT.md](./DEVELOPMENT.md)          | Development setup, tooling, git hooks   |
| [TESTING.md](./docs/TESTING.md)             | Testing strategy and commands           |

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Language**: TypeScript (strict)
- **Server**: Bun.serve (HTTP + WebSocket on single port)
- **Process Management**: Watchdog supervises gateway + agent-host
- **SDK Isolation**: Agent-host server (WebSocket RPC) owns Claude Agent SDK processes
- **Database**: SQLite (workspaces + sessions)
- **TTS**: Cartesia Sonic 3.0 (real-time) + ElevenLabs v3 (pre-generated content)
- **Router**: Hand-rolled pushState router (~75 lines, zero deps)
- **Network**: Tailscale for secure remote access
- **Tooling**: oxfmt + oxlint, Husky git hooks, tsgo fast checks

## License

MIT

---

_Built with love by Claudia_ 💙
