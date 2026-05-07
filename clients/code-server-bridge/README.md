# Anima Bridge

VS Code (code-server) extension that bridges the Anima gateway to the running
editor. Lets chat, CLI, MCP, and voice clients drive code-server through the
`editor.*` methods on the gateway:

- `editor.open_file({ path, line?, column? })` — open a file, optionally
  jumping to a line/column
- `editor.get_selection()` — return the active editor's selection text + range
- `editor.get_active_file()` — return the active editor's file path
- `editor.active_file_changed` event — fires whenever the active editor
  changes (the bridge pushes this up automatically)

The bridge connects to the gateway over WebSocket on activation, registers
itself via `editor.register`, and subscribes exclusively to `editor.command`
so the most recently opened code-server tab handles commands.

## Build

```bash
bun install
bun run build           # → dist/extension.js
bun run package         # → anima-bridge.vsix
```

## Install in code-server

```bash
code-server --install-extension /path/to/anima-bridge.vsix
```

Or drag the `.vsix` into the code-server Extensions panel.

## Configure

Open code-server's user settings JSON and add:

```jsonc
{
  // WebSocket URL of the gateway. Use wss:// for remote (Tailscale, public domain).
  "anima.gatewayUrl": "wss://anima.example.com/ws",
  // Bearer token — matches `gateway.token` in ~/.anima/anima.json on the host
  // running the gateway. Leave empty if the gateway is unauthenticated locally.
  "anima.gatewayToken": "anima_sk_...",
}
```

A reload (`Cmd/Ctrl+Shift+P → Developer: Reload Window`) reconnects with the new
config; the bridge also auto-restarts on settings change.

## Verify

Once the bridge is connected, the gateway's `editor.health_check` should
report a connected client:

```bash
anima call editor.health_check
# → { ok: true, status: "healthy", items: [{ id: "<instance-id>", ... }] }
```

And `editor.open_file` should pop a file open in code-server:

```bash
anima editor open_file --path "$(pwd)/README.md" --line 10
```

## Status bar

A small `Anima ●/◐/○` indicator in the status bar shows the connection state.
Click it for a popup with the gateway URL and instance ID.

Manual commands:

- `Anima: Reconnect Bridge` — force-reconnect after a network blip
- `Anima: Show Bridge Status` — popup with current state
