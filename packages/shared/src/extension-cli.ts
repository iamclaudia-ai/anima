/**
 * Extension CLI contributions.
 *
 * An extension may ship `src/cli.ts` exporting `cli: ExtensionCli`. The anima
 * CLI loads it lazily when the first argument matches the extension id, and
 * runs a declared command locally instead of calling a gateway method.
 *
 * A command belongs here only if it would behave differently when the CLI runs
 * on another machine than the gateway: it needs the caller's stdio, exit code,
 * or local files. Everything else is a server method.
 *
 * `cli.ts` must stay dependency-light: it may not import the extension's
 * server entry (`src/index.ts`) or `@anima/extension-host`.
 */

export interface ExtensionCliContext {
  /** Authenticated gateway WebSocket URL, for commands that also call methods. */
  gatewayUrl: string;
}

export interface ExtensionCliCommand {
  /** One-line summary shown in `anima <namespace> --help`. */
  description: string;
  /** Argument synopsis after `anima <namespace> <command>`, e.g. `<skill-id> [args...]`. */
  usage: string;
  /** Runs the command. Resolves to the process exit code (default 0). */
  run(args: string[], ctx: ExtensionCliContext): Promise<number | void>;
}

export interface ExtensionCli {
  commands: Record<string, ExtensionCliCommand>;
}
