# Editor Architecture

code-server integration through a VS Code "bridge" extension that wires Anima's gateway into the running editor. Lets chat, CLI, voice, MCP, and any other Anima client open files, read selections, and watch active-editor changes — all from outside the iframe.

The editor extension is an instance of the [Bridge Extension Pattern](./BRIDGE-PATTERN.md). For the general design, the wire protocol, and the rules every bridge extension follows, read that doc first; this one only documents what's editor-specific.

## Connection Architecture

```
┌──────────────┐     ┌──────────────┐     ┌────────────────────┐     ┌─────────────────┐
│ CLI / Agent  │     │   Gateway    │     │  Editor extension  │     │  code-server    │
│ (chat, voice,│     │   :30086     │     │  (in-process       │     │  bridge .vsix   │
│  MCP, …)     │     │              │     │   AnimaExtension)  │     │  (in code-      │
│              │     │              │     │                    │     │   server's      │
│              │     │              │     │                    │     │   ext host)     │
└──────┬───────┘     └──────┬───────┘     └────────┬───────────┘     └────────┬────────┘
       │                    │                       │                           │
       │ req:               │                       │                           │
       │ editor.open_file   │                       │                           │
       ├───────────────────►│                       │                           │
       │                    │  routes to ext        │                           │
       │                    ├──────────────────────►│                           │
       │                    │                       │                           │
       │                    │                       │  emits                    │
       │                    │                       │  editor.command           │
       │                    │                       │  { requestId,             │
       │                    │                       │    action: "open_file",   │
       │                    │                       │    params }               │
       │                    │◄──────────────────────┤                           │
       │                    │                       │                           │
       │                    │  fanout to            │                           │
       │                    │  exclusive subscriber │                           │
       │                    ├──────────────────────────────────────────────────►│
       │                    │                       │                           │
       │                    │                       │                           │  vscode.window.
       │                    │                       │                           │  showTextDocument(
       │                    │                       │                           │    uri,
       │                    │                       │                           │    { selection })
       │                    │                       │                           │
       │                    │  req:                 │                           │
       │                    │  editor.response      │                           │
       │                    │  { requestId,         │                           │
       │                    │    success, data }    │                           │
       │                    │◄──────────────────────────────────────────────────┤
       │                    │                       │                           │
       │                    │  routes to ext        │                           │
       │                    ├──────────────────────►│                           │
       │                    │                       │                           │
       │                    │                       │  resolves pending         │
       │                    │                       │  request by requestId     │
       │                    │                       │                           │
       │ res: ok            │                       │                           │
       │◄───────────────────┤                       │                           │
```

Spontaneous events (the user clicks a different file in code-server) flow the other direction:

```
code-server bridge → editor.notify_active_file({ path })
                  ↓
editor extension re-emits → editor.active_file_changed { path }
                  ↓
all gateway subscribers (chat, CLI, voice, hooks, …) receive it
```

## Public API

| Method                   | Params                               | Returns                                  | Purpose                                                      |
| ------------------------ | ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------ |
| `editor.open_file`       | `{ path, line?, column?, preview? }` | `{ ok: true, path }`                     | Open a file, optionally jumping to a 1-indexed line/column   |
| `editor.get_selection`   | `{}`                                 | `{ path, text, range, isEmpty } \| null` | Active editor's selection text + 1-indexed range             |
| `editor.get_active_file` | `{}`                                 | `{ path: string \| null }`               | Active editor's file path, or null when no editor is focused |
| `editor.health_check`    | `{}`                                 | `HealthCheckResponse`                    | Connected bridge count + per-bridge details                  |

Both line and column are 1-indexed in the public API (matching what humans expect), even though VS Code internally uses 0-indexed positions. The bridge converts at the boundary.

`preview` defaults to `true` — files open in VS Code's "preview" tab style (replaces previous preview, italicized title). Pass `false` to pin the tab.

## Public events

| Event                        | Payload                    | When it fires                                                              |
| ---------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `editor.active_file_changed` | `{ path: string \| null }` | The user (or another caller) changed which editor is focused; null on blur |

Subscribe via `gateway.subscribe { events: ["editor.active_file_changed"] }`.

The shape is intentionally minimal — chat/CLI consumers only need to know "what file is on screen now" to add it to context. Selection-changed and edit events would be much chattier and aren't currently emitted; add them as future `editor.notify_*` methods if a real consumer needs them.

## Internal protocol (shim ↔ extension)

These are the bridge-pattern building blocks. Callers should never invoke them directly.

| Method                      | Direction        | Purpose                                                            |
| --------------------------- | ---------------- | ------------------------------------------------------------------ |
| `editor.command` event      | extension → shim | Dispatched action with requestId — the shim subscribes exclusively |
| `editor.register`           | shim → extension | Shim claims a slot with `{ instanceId, codeServerVersion? }`       |
| `editor.response`           | shim → extension | Reply correlated by requestId                                      |
| `editor.notify_active_file` | shim → extension | Active editor changed; extension re-emits as the public event      |

## Configuration

### Gateway side — `~/.anima/anima.json`

```jsonc
{
  "extensions": {
    "editor": {
      "enabled": true,
      "config": {},
      "webConfig": {
        // Absolute URL of code-server, used by the EditorPanel iframe.
        "url": "https://code.example.com",
      },
    },
  },
}
```

The `webConfig.url` is consumed by the in-browser `EditorPanel` (the iframe in chat's `ide` layout) — it's separate from how the bridge inside code-server reaches the gateway, which goes the other way around.

### code-server side — VS Code user settings

```jsonc
{
  // WebSocket URL of the gateway. Use wss:// for remote (Tailscale, public domain).
  "anima.gatewayUrl": "wss://anima.example.com/ws",
  // Bearer token — matches `gateway.token` in ~/.anima/anima.json on the host running the gateway.
  "anima.gatewayToken": "anima_sk_...",
}
```

These are read on activation; changes auto-restart the bridge connection.

## Active-workspace integration

The `EditorPanel` (rendered as a sibling of `chat.main` in the chat layout) reads the active workspace's `cwd` from `useWorkspace()` and templates `?folder=<cwd>` onto the configured code-server URL. Switching chat workspaces re-templates the iframe `src` which reloads code-server at the new folder.

This is a Phase-1 trade-off: workspace switches lose code-server session state. The bridge `.vsix` provides a path forward — the chat side could send `editor.open_file` for the new folder's anchor file rather than reloading the iframe — but that's a future enhancement, not something the current pipeline does.

## Building & installing the bridge

```bash
cd clients/code-server-bridge
bun install
bun run package          # → anima-bridge.vsix (~25 KB)
```

The build:

- Bundles `src/extension.ts` + dependencies into `dist/extension.js` via `Bun.build` (target node, format cjs, `vscode` external, `ws` inlined)
- Packages with `vsce package --no-dependencies` (the flag is **required** — without it, `vsce` follows Bun's workspace symlinks and tries to bundle the entire monorepo)

Install in code-server:

```bash
code-server --install-extension /path/to/anima-bridge.vsix
```

Reload the code-server window (`Cmd/Ctrl+Shift+P` → "Developer: Reload Window") to pick up the new extension.

A status-bar indicator (`Anima ●` / `◐` / `○`) shows connection state. Click it for current URL + instance ID. Manual commands:

- `Anima: Reconnect Bridge` — force-reconnect after a network blip
- `Anima: Show Bridge Status` — info popup

## Verifying the round trip

After installation, with the bridge connected:

```bash
# Should report a connected bridge
anima call editor.health_check

# Pop a file open in code-server (jumps to line 100)
anima editor open_file --path "$HOME/Projects/iamclaudia-ai/anima/CLAUDE.md" --line 100

# Whatever's currently selected
anima call editor.get_selection

# Subscribe to active-file changes; click around in code-server to see events
anima call gateway.subscribe '{"events":["editor.active_file_changed"]}'
```

If `editor.health_check` shows zero connected bridges:

1. Check the status bar in code-server — `Anima ○` means disconnected
2. Open code-server's developer console (`Cmd/Ctrl+Shift+P` → "Developer: Toggle Developer Tools") and look for `[anima-bridge]` log lines
3. Verify `anima.gatewayUrl` and `anima.gatewayToken` match the gateway you're trying to reach
4. Try `Anima: Reconnect Bridge` from the command palette

## Adding a new public action

1. **Server side** (`extensions/editor/src/index.ts`):
   - Define a Zod schema for the params
   - Add the method declaration with the schema and a description
   - Add a one-line dispatch in the `methods` map: `"editor.foo": (p) => sendCommand("foo", p)`
2. **Bridge side** (`clients/code-server-bridge/src/actions.ts`):
   - Add a handler function
   - Add a case in the `dispatch` switch
3. **Tests** (`extensions/editor/src/index.test.ts`):
   - Add a dispatch + correlation test for the new action
4. **Docs**:
   - Add a row to the public API table above
5. Run `bun run docs:api` to regenerate `docs/API-REFERENCE.md` so the new method shows up there too

The pattern is symmetric — the extension declares the schema and one-line dispatch, the bridge does the actual work. Most actions are 5-10 lines on the bridge side; the editor extension itself stays tiny.

## File map

```
extensions/editor/
├── src/
│   ├── index.ts              # AnimaExtension — sendCommand, register, response, notify_*, health
│   ├── index.test.ts         # 9 unit tests — dispatch, correlation, disconnect, re-register, …
│   ├── routes.ts             # ExtensionWebContribution — declares the editor.viewer panel
│   └── panels/
│       └── EditorPanel.tsx   # Iframe + ?folder=<cwd> templating
└── package.json              # Both `.` and `./routes` exports

clients/code-server-bridge/
├── src/
│   ├── extension.ts          # VS Code activate hook — settings, status bar, lifecycle
│   ├── gateway-client.ts     # WS client — connect, subscribe exclusively, dispatch, reconnect
│   └── actions.ts            # open_file / get_selection / get_active_file handlers
├── bundle.ts                 # Bun.build entry — node target, ws inlined, vscode external
├── package.json              # VS Code extension manifest + bridge config schema
└── README.md                 # Build + install + configure
```
