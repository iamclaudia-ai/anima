import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

import type { ParseResult, ShellCommand } from "./types";

let parserPromise: Promise<Parser> | null = null;

async function createParser(): Promise<Parser> {
  const wasmPath = fileURLToPath(import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
  await Parser.init();
  const language = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

async function getParser(): Promise<Parser> {
  parserPromise ??= createParser();
  return parserPromise;
}

function commandName(node: Node): string | null {
  const nameNode = node.children.find((child) => child.type === "command_name");
  const word = nameNode?.namedChildren[0] ?? nameNode;
  return word ? shellWordText(word.text) : null;
}

function shellWordText(text: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else out += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && index + 1 < text.length) {
        index += 1;
        out += text[index];
      } else {
        out += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\\" && index + 1 < text.length) {
      index += 1;
      out += text[index];
    } else {
      out += char;
    }
  }

  return out;
}

function commandArgv(node: Node, name: string): string[] {
  const argv = [name];
  for (const child of node.namedChildren) {
    if (child.type === "command_name") continue;
    if (child.type === "file_redirect" || child.type === "heredoc_redirect") continue;
    argv.push(shellWordText(child.text));
  }
  return argv;
}

function collectCommands(
  node: Node,
  commands: ShellCommand[],
  pipelineId: number | null = null,
  pipelineIndex: number | null = null,
  pipelineLength: number | null = null,
): void {
  if (node.type === "pipeline") {
    const id = node.id;
    const pipelineElements = node.namedChildren;
    pipelineElements.forEach((child, index) => {
      collectCommands(child, commands, id, index, pipelineElements.length);
    });
    return;
  }

  if (node.type === "command") {
    collectCommandNode(node, commands, pipelineId, pipelineIndex, pipelineLength);
    return;
  }

  for (const child of node.namedChildren) {
    collectCommands(child, commands, pipelineId, pipelineIndex, pipelineLength);
  }
}

function collectCommandNode(
  node: Node,
  commands: ShellCommand[],
  pipelineId: number | null,
  pipelineIndex: number | null,
  pipelineLength: number | null,
): void {
  const name = commandName(node);
  if (!name) return;

  commands.push({
    id: node.id,
    name,
    argv: commandArgv(node, name),
    raw: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    pipelineId,
    pipelineIndex,
    pipelineLength,
  });

  for (const child of node.namedChildren) {
    if (child.type !== "command_name") collectCommands(child, commands);
  }
}

export async function parseShell(source: string): Promise<ParseResult> {
  try {
    const parser = await getParser();
    const tree = parser.parse(source);
    if (!tree) {
      return { ok: false, hasError: true, commands: [], error: "parse returned null" };
    }

    const commands: ShellCommand[] = [];
    collectCommands(tree.rootNode, commands);

    return {
      ok: !tree.rootNode.hasError,
      hasError: tree.rootNode.hasError,
      commands,
      ...(tree.rootNode.hasError ? { error: "shell syntax contains parse errors" } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      hasError: true,
      commands: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
