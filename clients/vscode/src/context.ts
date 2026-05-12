import * as vscode from "vscode";

export interface EditorContext {
  /** Full file path */
  filePath: string;
  /** File name only */
  fileName: string;
  /** Language ID (typescript, python, etc.) */
  languageId: string;
  /** Current selection text (if any) */
  selection?: string;
  /** Selection range */
  selectionRange?: {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  };
  /** Current line number (1-indexed) */
  currentLine: number;
  /** Total lines in file */
  totalLines: number;
  /** Workspace folder name */
  workspaceFolder?: string;
  /** Relative path from workspace root */
  relativePath?: string;
  /** Diagnostics (errors/warnings) for current file */
  diagnostics: DiagnosticInfo[];
}

interface DiagnosticInfo {
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  line: number;
  column: number;
}

/**
 * Get context from the current editor
 */
export function getEditorContext(editor: vscode.TextEditor): EditorContext {
  const document = editor.document;
  const selection = editor.selection;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

  // Get diagnostics for this file
  const rawDiagnostics = vscode.languages.getDiagnostics(document.uri);
  const diagnostics: DiagnosticInfo[] = rawDiagnostics.map((d) => ({
    message: d.message,
    severity: getSeverityString(d.severity),
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
  }));

  const context: EditorContext = {
    filePath: document.uri.fsPath,
    fileName: document.fileName.split("/").pop() || document.fileName,
    languageId: document.languageId,
    currentLine: selection.active.line + 1,
    totalLines: document.lineCount,
    diagnostics,
  };

  // Add selection if present
  if (!selection.isEmpty) {
    context.selection = document.getText(selection);
    context.selectionRange = {
      startLine: selection.start.line + 1,
      startChar: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endChar: selection.end.character + 1,
    };
  }

  // Add workspace info if available
  if (workspaceFolder) {
    context.workspaceFolder = workspaceFolder.name;
    context.relativePath = vscode.workspace.asRelativePath(document.uri, false);
  }

  return context;
}

function getSeverityString(
  severity: vscode.DiagnosticSeverity,
): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}
