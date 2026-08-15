/**
 * Minimal tmux helpers for the Claude CLI runtime (#33).
 *
 * The runtime drives a real `claude` TUI living in a detached tmux session.
 * These are thin, synchronous wrappers around the `tmux` binary (input side);
 * the model stream comes back out-of-band via the proxy, not from the pane.
 */

import { execFileSync } from "node:child_process";

/** POSIX single-quote a string for safe embedding in a shell command. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8" }).toString();
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    return e.stdout ? e.stdout.toString() : "";
  }
}

export function hasSession(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a live `claude` process for this session id exists.
 *
 * Matches the CLI's own argv (`--resume <id>` / `--session-id <id>`), which is
 * far more reliable than the pane's foreground command: it stays true while a
 * Bash/other tool subprocess is foregrounded mid-turn, and survives the binary
 * being renamed across versions. The leading `--` separates pgrep options from
 * the (dash-prefixed) ERE pattern.
 */
export function claudeProcessAlive(id: string): boolean {
  try {
    execFileSync("pgrep", ["-f", "--", `--(resume|session-id) ${id}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the proxy port out of a `ps eww` environment dump.
 *
 * `base-url` sessions carry `ANTHROPIC_BASE_URL`; `mitm` sessions carry
 * `HTTPS_PROXY`. Exported separately from the process lookup so the parsing is
 * testable without spawning anything.
 */
export function parseProxyPortFromEnv(psOutput: string): number | null {
  const match =
    /ANTHROPIC_BASE_URL=https?:\/\/[^:\s]+:(\d+)/.exec(psOutput) ??
    /HTTPS_PROXY=https?:\/\/[^:\s]+:(\d+)/.exec(psOutput);
  const port = match?.[1] ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * The proxy port a still-running `claude` process was launched against.
 *
 * The CLI reads `ANTHROPIC_BASE_URL` once at startup, so its target is fixed
 * for the life of the process. When agent-host restarts underneath a surviving
 * CLI, re-deriving the port can land somewhere else — the derived port may have
 * been taken at spawn time (this machine has other services squatting in the
 * range) and free now, or the reverse. The CLI would then be talking to a port
 * with nothing behind it, which surfaces as:
 *
 *   API Error: Connection refused — a firewall or proxy may be blocking it
 *
 * Asking the process itself removes the guesswork.
 */
export function readClaudeProxyPort(id: string): number | null {
  try {
    const pids = execFileSync("pgrep", ["-f", "--", `--(resume|session-id) ${id}`], {
      encoding: "utf-8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (pids.length === 0) return null;

    // `ps eww` prints the process environment after the command line.
    const out = execFileSync("ps", ["eww", "-o", "command=", "-p", pids[0]!], {
      encoding: "utf-8",
    });
    return parseProxyPortFromEnv(out);
  } catch {
    return null;
  }
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /** [binary, ...args] — quoted and run via the session's shell. */
  command: string[];
  /** Environment assignments prefixed onto the command (empty value clears). */
  env?: Record<string, string>;
}

/** `K=V ... 'bin' 'arg'...` — env assignments (empty value clears) + quoted argv. */
function buildCommandLine(command: string[], env?: Record<string, string>): string {
  const envPrefix = Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${sq(v)}`)
    .join(" ");
  return `${envPrefix} ${command.map(sq).join(" ")}`.trim();
}

export function newSession(opts: NewSessionOptions): void {
  const cmd = buildCommandLine(opts.command, opts.env);
  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-x",
    "220",
    "-y",
    "50",
    "-c",
    opts.cwd,
    cmd,
  ]);
}

/**
 * Launch a command at the shell prompt of an existing session's pane.
 *
 * Used to relaunch `claude` when the pane is alive but the CLI died (crash, or a
 * manually re-created session) — unlike kill+new-session, this keeps any client
 * attached. `C-u` clears stray input first, then the line is typed and submitted.
 */
export function runInPane(name: string, command: string[], env?: Record<string, string>): void {
  const line = buildCommandLine(command, env);
  tmux(["send-keys", "-t", name, "C-u"]);
  tmux(["send-keys", "-t", name, "-l", line]);
  tmux(["send-keys", "-t", name, "Enter"]);
}

export function capturePane(name: string): string {
  return tmux(["capture-pane", "-t", name, "-p"]);
}

export function sendKey(name: string, key: string): void {
  tmux(["send-keys", "-t", name, key]);
}

/**
 * Bracketed-paste (possibly multi-line) text into the TUI input WITHOUT
 * submitting — loads it as a tmux buffer and pastes it (preserves newlines,
 * unlike `send-keys -l`). Use {@link submit} to send it.
 */
export function pasteText(name: string, text: string): void {
  tmux(["set-buffer", "--", text]);
  tmux(["paste-buffer", "-t", name, "-d", "-p"]);
}

/** Submit the TUI's current input line (Enter). */
export function submit(name: string): void {
  tmux(["send-keys", "-t", name, "Enter"]);
}

/** Paste text and submit it as one turn, after a short settle delay. */
export async function sendText(name: string, text: string): Promise<void> {
  pasteText(name, text);
  await new Promise((r) => setTimeout(r, 150));
  submit(name);
}

export function killSession(name: string): void {
  if (hasSession(name)) tmux(["kill-session", "-t", name]);
}

export interface TmuxSessionInfo {
  name: string;
  /** Last activity time, unix seconds. */
  activitySec: number;
  /** True when one or more clients are attached. */
  attached: boolean;
}

/**
 * A pane's current working directory.
 *
 * Used to adopt a CLI session whose registry record was lost: `resume` needs a
 * cwd, and the pane already knows the one it was launched in.
 */
export function paneCurrentPath(name: string): string | null {
  const out = tmux(["display-message", "-p", "-t", name, "#{pane_current_path}"]).trim();
  return out || null;
}

/** Snapshot of every tmux session on this host (empty array if tmux is dead). */
export function listTmuxSessions(): TmuxSessionInfo[] {
  const out = tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_activity}\t#{session_attached}",
  ]);
  if (!out.trim()) return [];
  return out
    .trim()
    .split("\n")
    .map((line) => {
      const [name, activity, attached] = line.split("\t");
      return {
        name: name ?? "",
        activitySec: Number(activity) || 0,
        attached: Number(attached) > 0,
      };
    })
    .filter((s) => s.name);
}
