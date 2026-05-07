/**
 * Action dispatch — turns `editor.command` actions from the gateway into
 * VS Code API calls and shapes the response.
 *
 * Add a new public command in two places:
 *   1. `extensions/editor/src/index.ts`   — declare the method + schema
 *   2. here                                — implement the action
 *
 * The contract for every action: take a params record, return JSON-safe data
 * (or throw). Errors propagate back through `editor.response` as `success:
 * false, error: <message>` and surface to the caller as a rejected promise.
 */

import * as vscode from "vscode";

export type ActionParams = Record<string, unknown>;

interface SelectionPayload {
  path: string;
  text: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  isEmpty: boolean;
}

function activeEditor(): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("No active editor");
  return editor;
}

function toClientPosition(p: vscode.Position): { line: number; column: number } {
  // VS Code zero-indexes line/character; report 1-indexed for human-friendly
  // UIs (matches what `editor.open_file` accepts).
  return { line: p.line + 1, column: p.character + 1 };
}

async function openFile(params: ActionParams): Promise<{ ok: true; path: string }> {
  const path = params.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path is required");
  }

  const line = typeof params.line === "number" ? params.line : undefined;
  const column = typeof params.column === "number" ? params.column : undefined;
  const preview = params.preview === undefined ? true : Boolean(params.preview);

  const uri = vscode.Uri.file(path);

  // Build a selection if a line was specified — VS Code uses zero-indexed
  // positions internally.
  let selection: vscode.Range | undefined;
  if (line !== undefined && line > 0) {
    const zeroLine = line - 1;
    const zeroCol = column && column > 0 ? column - 1 : 0;
    const pos = new vscode.Position(zeroLine, zeroCol);
    selection = new vscode.Range(pos, pos);
  }

  await vscode.window.showTextDocument(uri, {
    preview,
    selection,
    preserveFocus: false,
  });

  return { ok: true, path };
}

function getSelection(): SelectionPayload | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const sel = editor.selection;
  return {
    path: editor.document.uri.fsPath,
    text: editor.document.getText(sel),
    range: {
      start: toClientPosition(sel.start),
      end: toClientPosition(sel.end),
    },
    isEmpty: sel.isEmpty,
  };
}

function getActiveFile(): { path: string | null } {
  const editor = vscode.window.activeTextEditor;
  return { path: editor ? editor.document.uri.fsPath : null };
}

/**
 * Dispatch an `editor.command` action to its handler. Unknown actions throw —
 * the gateway client converts that into an `editor.response` failure for the
 * caller.
 */
export async function dispatch(action: string, params: ActionParams): Promise<unknown> {
  switch (action) {
    case "open_file":
      return openFile(params);
    case "get_selection":
      return getSelection();
    case "get_active_file":
      return getActiveFile();
    default:
      throw new Error(`Unknown editor action: ${action}`);
  }
}
