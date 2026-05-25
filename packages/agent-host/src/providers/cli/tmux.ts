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
 * Send a (possibly multi-line) prompt to the TUI: load it as a tmux buffer and
 * bracketed-paste it (preserves newlines, unlike `send-keys -l`), then submit
 * with Enter after a short settle delay.
 */
export async function sendText(name: string, text: string): Promise<void> {
  tmux(["set-buffer", "--", text]);
  tmux(["paste-buffer", "-t", name, "-d", "-p"]);
  await new Promise((r) => setTimeout(r, 150));
  tmux(["send-keys", "-t", name, "Enter"]);
}

export function killSession(name: string): void {
  if (hasSession(name)) tmux(["kill-session", "-t", name]);
}
