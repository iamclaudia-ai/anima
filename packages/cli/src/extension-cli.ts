/**
 * Loader for extension CLI contributions (`extensions/<id>/src/cli.ts`).
 *
 * Lookups are by convention on disk, and modules are imported lazily: only the
 * namespace named by the first CLI argument is ever loaded, so contributions
 * add nothing to startup for unrelated commands.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionCli, ExtensionCliCommand } from "@anima/shared";

/** `packages/cli/src` → repo root → `extensions`. */
export const DEFAULT_EXTENSIONS_DIR = resolve(import.meta.dir, "..", "..", "..", "extensions");

const NAMESPACE_RE = /^[a-z][a-z0-9-]*$/;

/** Rejects anything that could escape the extensions directory. */
export function isValidNamespace(namespace: string): boolean {
  return NAMESPACE_RE.test(namespace);
}

export function extensionCliPath(namespace: string, extensionsDir: string): string | null {
  if (!isValidNamespace(namespace)) return null;
  const path = join(extensionsDir, namespace, "src", "cli.ts");
  return existsSync(path) ? path : null;
}

function isCommand(value: unknown): value is ExtensionCliCommand {
  if (!value || typeof value !== "object") return false;
  const cmd = value as Record<string, unknown>;
  return (
    typeof cmd.description === "string" &&
    typeof cmd.usage === "string" &&
    typeof cmd.run === "function"
  );
}

/**
 * Imports `extensions/<namespace>/src/cli.ts` if it exists. Returns null when
 * the extension contributes no CLI. Throws when the file exists but does not
 * export a well-formed `cli`, so a broken contribution fails loudly instead of
 * silently falling through to the gateway.
 */
export async function loadExtensionCli(
  namespace: string,
  extensionsDir: string = DEFAULT_EXTENSIONS_DIR,
): Promise<ExtensionCli | null> {
  const path = extensionCliPath(namespace, extensionsDir);
  if (!path) return null;

  const mod = (await import(path)) as { cli?: unknown };
  const cli = mod.cli as { commands?: unknown } | undefined;
  if (!cli || typeof cli.commands !== "object" || cli.commands === null) {
    throw new Error(`${path} must export \`cli\` with a \`commands\` object`);
  }
  for (const [name, command] of Object.entries(cli.commands)) {
    if (!isCommand(command)) {
      throw new Error(`${path}: command "${name}" needs description, usage, and run()`);
    }
  }
  return cli as ExtensionCli;
}

/** Namespaces that ship a cli.ts. Checks existence only; nothing is imported. */
export function listExtensionCliNamespaces(
  extensionsDir: string = DEFAULT_EXTENSIONS_DIR,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => extensionCliPath(name, extensionsDir) !== null).sort();
}

export function formatLocalCommands(namespace: string, cli: ExtensionCli): string[] {
  return Object.entries(cli.commands)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, cmd]) =>
        `anima ${namespace} ${name} ${cmd.usage}`.trimEnd() + `  — ${cmd.description}`,
    );
}
