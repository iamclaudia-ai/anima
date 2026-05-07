/**
 * Anima Bridge — VS Code (code-server) extension entry.
 *
 * On activation, opens a WebSocket to the configured Anima gateway, registers
 * itself via `editor.register`, and subscribes exclusively to `editor.command`
 * events. Incoming commands are dispatched through actions.ts.
 *
 * Spontaneous events (active editor changed) are pushed up through
 * `editor.notify_active_file` so any subscriber on the gateway side gets the
 * `editor.active_file_changed` event for free.
 *
 * Settings:
 *   anima.gatewayUrl    — ws:// or wss:// URL of the gateway
 *   anima.gatewayToken  — bearer token (matches gateway.token in anima.json)
 *
 * Commands:
 *   Anima: Reconnect Bridge        — force-reconnect after token/URL change
 *   Anima: Show Bridge Status      — quick info pop-up
 */

import * as vscode from "vscode";
import { GatewayClient, type ConnectionState } from "./gateway-client";
import { dispatch } from "./actions";

const INSTANCE_ID_KEY = "anima.bridge.instanceId";
const STATUS_NAMES: Record<ConnectionState, string> = {
  connected: "Anima ●",
  connecting: "Anima ◐",
  disconnected: "Anima ○",
};

export function activate(context: vscode.ExtensionContext): void {
  const log = (msg: string, extra?: Record<string, unknown>) => {
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    console.log(`[anima-bridge] ${msg}${suffix}`);
  };

  // Stable instance ID — persists across reloads so the editor extension can
  // recognise the same shim re-attaching after a code-server restart.
  let instanceId = context.globalState.get<string>(INSTANCE_ID_KEY);
  if (!instanceId) {
    instanceId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();
    void context.globalState.update(INSTANCE_ID_KEY, instanceId);
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "anima.bridge.showStatus";
  status.text = STATUS_NAMES.disconnected;
  status.tooltip = "Anima bridge — click for status";
  status.show();
  context.subscriptions.push(status);

  function readSettings(): { url: string; token: string } {
    const cfg = vscode.workspace.getConfiguration("anima");
    return {
      url: cfg.get<string>("gatewayUrl") ?? "ws://localhost:30086/ws",
      token: cfg.get<string>("gatewayToken") ?? "",
    };
  }

  let client: GatewayClient | null = null;

  function start(): void {
    if (client) {
      client.dispose();
      client = null;
    }
    const { url, token } = readSettings();
    log("starting", { url, hasToken: token.length > 0 });

    client = new GatewayClient({
      url,
      token,
      instanceId: instanceId as string,
      codeServerVersion: vscode.version,
      onCommand: (action, params) => dispatch(action, params),
      onStateChange: (state) => {
        status.text = STATUS_NAMES[state];
      },
      log,
    });
    client.start();
  }

  start();

  // Push spontaneous "active file" events up through the gateway. The editor
  // extension re-emits these as `editor.active_file_changed` for any
  // subscriber (chat, CLI, voice) to consume.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const path = editor ? editor.document.uri.fsPath : null;
      client?.send("editor.notify_active_file", { path });
    }),
  );

  // Re-create the client when the user changes URL or token in settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("anima.gatewayUrl") ||
        event.affectsConfiguration("anima.gatewayToken")
      ) {
        log("config changed, restarting");
        start();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anima.bridge.reconnect", () => {
      log("manual reconnect requested");
      client?.reconnect();
    }),
    vscode.commands.registerCommand("anima.bridge.showStatus", () => {
      const state = client?.getState() ?? "disconnected";
      const { url } = readSettings();
      void vscode.window.showInformationMessage(
        `Anima bridge: ${state} → ${url} (instance ${instanceId?.slice(0, 8)})`,
      );
    }),
  );

  context.subscriptions.push({
    dispose() {
      client?.dispose();
      client = null;
    },
  });
}

export function deactivate(): void {
  // Subscriptions handle teardown automatically.
}
