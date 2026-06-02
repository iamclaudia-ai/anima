import type { ParseResult, PolicyResult, ShellCommand } from "./types";

const GH_STACK_TAIL_DENY =
  "Blocked: don't pipe gh-stack into tail/head. It can hang the wrapper or get killed mid-operation (exit 143), leaving a rebase/push half-done. Re-run plainly; use 'tokf raw last' for the full output.";

const RG_REPLACE_DENY =
  "Blocked: don't use grep-style 'rg -rn'. In ripgrep, -r means --replace, so '-rn' replaces each match with 'n' and corrupts source-looking output. Use 'rg -n' instead; ripgrep searches recursively by default.";

const TMUX_KILL_SERVER_DENY =
  "Blocked: tmux kill-server would terminate the tmux-wrap session and may kill the agent CLI itself. Tell Michael tmux is broken and ask him to restart or repair the tmux wrapper/session instead.";

function hasCompactRgReplaceNumberFlag(argv: string[]): boolean {
  return argv.some((arg) => {
    if (!arg.startsWith("-") || arg.startsWith("--")) return false;
    const flags = arg.slice(1);
    return flags.includes("r") && flags.includes("n");
  });
}

function hasGhJsonProjection(argv: string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--json" ||
      arg.startsWith("--json=") ||
      arg === "--jq" ||
      arg.startsWith("--jq=") ||
      arg === "-q",
  );
}

function isSourceSearch(command: ShellCommand): boolean {
  if (["rg", "grep", "egrep", "fgrep"].includes(command.name)) return true;
  return command.name === "git" && command.argv[1] === "grep";
}

function isTailOrHead(command: ShellCommand): boolean {
  return command.name === "tail" || command.name === "head";
}

function pipelineCommands(parse: ParseResult, command: ShellCommand): ShellCommand[] {
  if (command.pipelineId === null) return [command];
  return parse.commands
    .filter((candidate) => candidate.pipelineId === command.pipelineId)
    .sort((a, b) => (a.pipelineIndex ?? 0) - (b.pipelineIndex ?? 0));
}

function flowsToTailOrHead(parse: ParseResult, command: ShellCommand): boolean {
  const pipeline = pipelineCommands(parse, command);
  const index = pipeline.findIndex((candidate) => candidate.id === command.id);
  if (index < 0) return false;
  return pipeline.slice(index + 1).some(isTailOrHead);
}

export function evaluatePolicy(parse: ParseResult): PolicyResult {
  if (!parse.ok) {
    return {
      ok: false,
      denyReason: null,
      skipTokf: false,
      fallback: "parse-error",
      warnings: parse.error ? [parse.error] : [],
    };
  }

  for (const command of parse.commands) {
    if (command.name === "rg" && hasCompactRgReplaceNumberFlag(command.argv.slice(1))) {
      return { ok: true, denyReason: RG_REPLACE_DENY, skipTokf: false, warnings: [] };
    }

    if (command.name === "gh-stack" && flowsToTailOrHead(parse, command)) {
      return { ok: true, denyReason: GH_STACK_TAIL_DENY, skipTokf: false, warnings: [] };
    }

    if (command.name === "tmux" && command.argv[1] === "kill-server") {
      return { ok: true, denyReason: TMUX_KILL_SERVER_DENY, skipTokf: false, warnings: [] };
    }
  }

  const skipTokf = parse.commands.some((command) => {
    if (isSourceSearch(command)) return true;
    return command.name === "gh" && hasGhJsonProjection(command.argv.slice(1));
  });

  return { ok: true, denyReason: null, skipTokf, warnings: [] };
}
